'use strict'
// OAuth and AHP sign-in discovery; no `vscode` import, so `node --test` covers it.
const crypto = require('node:crypto')
const http = require('node:http')

const REDIRECT_PATH = '/callback'
// The CP matches a loopback redirect by scheme, host and path and ignores the port (RFC 8252 §7.3).
const REGISTERED_REDIRECT = `http://127.0.0.1${REDIRECT_PATH}`
const AGENT_PATH = /^\/(?:.*\/)?ahp\/agents\/[^/]+$/

const base64url = (bytes) => Buffer.from(bytes).toString('base64url')

/** The `wss://…/ahp/agents/<id>` endpoint an entry of `chat.remoteAgentHosts` names, if it is one. */
function agentEndpoint(address) {
  let url
  try {
    url = new URL(address)
  } catch {
    return undefined
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return undefined
  return AGENT_PATH.test(url.pathname) && !url.search && !url.hash ? url.toString() : undefined
}

/** Asks an AHP endpoint, before authenticating, which resource and authorization server it requires. */
function probeProtectedResource(address, { timeoutMs = 10_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(address)
    const finish = (settle, value) => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      settle(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`No answer from ${address}`)), timeoutMs)
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            channel: 'ahp-root://',
            clientId: crypto.randomUUID(),
            protocolVersions: ['1.0.0'],
            initialSubscriptions: ['ahp-root://']
          }
        })
      )
    )
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return finish(reject, new Error(`Unreadable answer from ${address}`))
      }
      if (message.id !== 1) return
      const resources = (message.result?.snapshots ?? [])
        .flatMap((snapshot) => snapshot.state?.agents ?? [])
        .flatMap((agent) => agent.protectedResources ?? [])
      const found = resources.find((entry) => entry.resource && entry.authorization_servers?.length)
      if (!found) return finish(reject, new Error(`${address} does not advertise a sign-in server`))
      finish(resolve, {
        resource: found.resource,
        authorizationServer: found.authorization_servers[0],
        scopes: found.scopes_supported ?? []
      })
    })
    socket.addEventListener('error', () => finish(reject, new Error(`Could not connect to ${address}`)))
    socket.addEventListener('close', () => finish(reject, new Error(`${address} closed before answering`)))
  })
}

async function readJson(response, what) {
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {}
  }
  if (!response.ok) {
    const reason = body.error_description ?? body.error ?? `HTTP ${response.status}`
    throw new Error(`${what} failed: ${reason}`)
  }
  return body
}

/** RFC 8414 metadata; the issuer must be the one the endpoint advertised. */
async function discover(issuer, fetchImpl = fetch) {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
  const metadata = await readJson(await fetchImpl(url), 'Sign-in server discovery')
  if (metadata.issuer !== issuer) throw new Error('Sign-in server discovery failed: issuer mismatch')
  for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint'])
    if (typeof metadata[key] !== 'string') throw new Error(`Sign-in server discovery failed: no ${key}`)
  return metadata
}

/** RFC 7591 registration of this public client; the caller caches the returned id per issuer. */
async function registerClient(metadata, fetchImpl = fetch) {
  const response = await fetchImpl(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'AgentConnect for VS Code',
      redirect_uris: [REGISTERED_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none'
    })
  })
  const body = await readJson(response, 'Client registration')
  if (typeof body.client_id !== 'string') throw new Error('Client registration failed: no client_id')
  return body.client_id
}

async function tokenRequest(metadata, params, fetchImpl) {
  const response = await fetchImpl(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString()
  })
  const body = await readJson(response, 'Token request')
  if (typeof body.access_token !== 'string') throw new Error('Token request failed: no access_token')
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : undefined
  }
}

const page = (title, detail) =>
  `<!doctype html><meta charset="utf-8"><title>AgentConnect</title><body style="font:16px system-ui;margin:3rem"><h1 style="font-size:1.25rem">${title}</h1><p>${detail}</p>`

/** Authorization code + PKCE through the browser, answered on a one-shot loopback listener. */
async function authorize({
  metadata,
  clientId,
  resource,
  scopes,
  openUrl,
  signal,
  timeoutMs = 300_000,
  fetchImpl = fetch
}) {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  const state = base64url(crypto.randomBytes(16))
  const server = http.createServer()
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  const redirectUri = `http://127.0.0.1:${server.address().port}${REDIRECT_PATH}`
  try {
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out')), timeoutMs)
      signal?.addEventListener('abort', () => reject(new Error('Sign-in cancelled')), { once: true })
      server.on('request', (req, res) => {
        const url = new URL(req.url, redirectUri)
        if (url.pathname !== REDIRECT_PATH) return void res.writeHead(404).end()
        const error = url.searchParams.get('error')
        const ok = !error && url.searchParams.get('state') === state && url.searchParams.get('code')
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          ok
            ? page('Signed in to AgentConnect', 'You can close this tab and return to VS Code.')
            : page('Sign-in did not complete', 'Return to VS Code and try again.')
        )
        clearTimeout(timer)
        if (ok) resolve(url.searchParams.get('code'))
        else reject(new Error(`Sign-in refused: ${error ?? 'unexpected response'}`))
      })
      const target = new URL(metadata.authorization_endpoint)
      for (const [key, value] of Object.entries({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        resource,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }))
        target.searchParams.set(key, value)
      Promise.resolve(openUrl(target.toString())).catch(reject)
    })
    return await tokenRequest(
      metadata,
      {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier
      },
      fetchImpl
    )
  } finally {
    server.close()
    server.closeAllConnections?.()
  }
}

/** Rotates the refresh token; the caller must store the result before using it. */
function refresh({ metadata, clientId, refreshToken, fetchImpl = fetch }) {
  return tokenRequest(
    metadata,
    { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
    fetchImpl
  )
}

module.exports = {
  agentEndpoint,
  authorize,
  discover,
  probeProtectedResource,
  refresh,
  registerClient,
  REGISTERED_REDIRECT
}

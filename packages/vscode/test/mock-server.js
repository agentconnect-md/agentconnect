'use strict'
// A stand-in for the CP OAuth server, keeping its rules: loopback redirects ignore the port, PKCE S256, rotating refresh tokens.
const crypto = require('node:crypto')
const http = require('node:http')

async function startAuthorizationServer() {
  const clients = new Map()
  const codes = new Map()
  const refreshTokens = new Map()
  const accessTokens = new Set()
  const requests = []
  let issuer
  const json = (res, status, body) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  const issue = (res, grant) => {
    const refreshToken = `refresh-${crypto.randomUUID()}`
    const accessToken = `access-${crypto.randomUUID()}`
    refreshTokens.set(refreshToken, grant)
    accessTokens.add(accessToken)
    json(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: grant.expiresIn ?? 3600,
      refresh_token: refreshToken,
      scope: grant.scope
    })
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer)
    let raw = ''
    for await (const chunk of req) raw += chunk
    requests.push({
      method: req.method,
      path: url.pathname,
      type: req.headers['content-type'],
      agent: req.headers['user-agent']
    })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`
      })
    if (url.pathname === '/oauth/register') {
      const body = JSON.parse(raw)
      if (!body.redirect_uris?.every((uri) => /^http:\/\/127\.0\.0\.1\//.test(uri)))
        return json(res, 400, {
          error: 'invalid_request',
          error_description: 'redirect_uris must be https or http loopback'
        })
      const clientId = `client-${clients.size + 1}`
      clients.set(clientId, body.redirect_uris)
      return json(res, 201, { client_id: clientId })
    }
    if (url.pathname === '/oauth/authorize') {
      const q = Object.fromEntries(url.searchParams)
      const redirect = new URL(q.redirect_uri)
      const registered = clients.get(q.client_id)?.some((uri) => new URL(uri).pathname === redirect.pathname)
      if (!registered || q.code_challenge_method !== 'S256') return json(res, 400, { error: 'invalid_request' })
      if (q.scope !== 'ahp' || !/\/ahp\/agents\//.test(q.resource ?? ''))
        redirect.searchParams.set('error', 'invalid_target')
      else {
        const code = crypto.randomUUID()
        codes.set(code, {
          clientId: q.client_id,
          redirectUri: q.redirect_uri,
          challenge: q.code_challenge,
          scope: q.scope,
          resource: q.resource
        })
        redirect.searchParams.set('code', code)
      }
      redirect.searchParams.set('state', q.state)
      return res.writeHead(302, { location: redirect.toString() }).end()
    }
    if (url.pathname === '/oauth/token') {
      const body = Object.fromEntries(new URLSearchParams(raw))
      if (body.grant_type === 'authorization_code') {
        const grant = codes.get(body.code)
        codes.delete(body.code)
        const challenge = crypto
          .createHash('sha256')
          .update(body.code_verifier ?? '')
          .digest('base64url')
        if (
          !grant ||
          grant.clientId !== body.client_id ||
          grant.redirectUri !== body.redirect_uri ||
          grant.challenge !== challenge
        )
          return json(res, 400, { error: 'invalid_grant' })
        return issue(res, grant)
      }
      if (body.grant_type === 'refresh_token') {
        const grant = refreshTokens.get(body.refresh_token)
        refreshTokens.delete(body.refresh_token)
        return grant ? issue(res, grant) : json(res, 400, { error: 'invalid_grant' })
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    res.writeHead(404).end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${server.address().port}`
  return {
    issuer,
    requests,
    codes,
    accessTokens, // Idle keep-alive connections would hold `close` open.
    close: () => new Promise((resolve) => (server.close(resolve), server.closeAllConnections()))
  }
}

/** A WebSocket whose only peer is a pre-authentication relay answering `initialize`. */
function fakeRelaySocket(protectedResource) {
  return class extends EventTarget {
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(text) {
      const { id } = JSON.parse(text)
      const result = {
        protocolVersion: '1.0.0',
        serverSeq: 0,
        snapshots: [{ state: { agents: [{ protectedResources: [protectedResource] }] } }]
      }
      queueMicrotask(() =>
        this.dispatchEvent(
          Object.assign(new Event('message'), { data: JSON.stringify({ jsonrpc: '2.0', id, result }) })
        )
      )
    }
    close() {}
  }
}

module.exports = { fakeRelaySocket, startAuthorizationServer }

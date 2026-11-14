'use strict'
const assert = require('node:assert/strict')
const Module = require('node:module')
const { test } = require('node:test')
const oauth = require('../lib/oauth')
const { fakeRelaySocket, startAuthorizationServer } = require('./mock-server')

const ENDPOINT = 'wss://relay.example.test/ahp/agents/11111111-2222-3333-4444-555555555555'
const RESOURCE = ENDPOINT.replace('wss:', 'https:')
// The browser: follows the authorization redirect to the loopback listener.
const browser = (url) => fetch(url).then((response) => response.text())

test('agentEndpoint accepts only per-agent AHP WebSocket addresses', () => {
  assert.equal(oauth.agentEndpoint(ENDPOINT), ENDPOINT)
  assert.equal(
    oauth.agentEndpoint('wss://relay.example.test/prefix/ahp/agents/abc'),
    'wss://relay.example.test/prefix/ahp/agents/abc'
  )
  for (const address of [
    'localhost:3000',
    'https://relay.example.test/ahp/agents/abc',
    `${ENDPOINT}?token=x`,
    'wss://relay.example.test/ahp'
  ])
    assert.equal(oauth.agentEndpoint(address), undefined)
})

test('probe reads the resource, sign-in server and scopes a relay advertises before authentication', async () => {
  const advertised = {
    resource: RESOURCE,
    authorization_servers: ['https://auth.example.test'],
    scopes_supported: ['ahp'],
    required: true
  }
  assert.deepEqual(await oauth.probeProtectedResource(ENDPOINT, { WebSocketImpl: fakeRelaySocket(advertised) }), {
    resource: RESOURCE,
    authorizationServer: 'https://auth.example.test',
    scopes: ['ahp']
  })
  await assert.rejects(
    oauth.probeProtectedResource(ENDPOINT, { WebSocketImpl: fakeRelaySocket({ resource: RESOURCE, required: true }) }),
    /does not advertise a sign-in server/
  )
})

test('authorization code + PKCE over a loopback redirect, then a rotating refresh', async (t) => {
  const server = await startAuthorizationServer()
  t.after(server.close)
  const metadata = await oauth.discover(server.issuer)
  const clientId = await oauth.registerClient(metadata)
  const tokens = await oauth.authorize({ metadata, clientId, resource: RESOURCE, scopes: ['ahp'], openUrl: browser })
  assert.match(tokens.accessToken, /^access-/)
  assert.deepEqual(tokens.scopes, ['ahp'])
  assert.equal(
    server.requests.find((request) => request.path === '/oauth/token').type,
    'application/x-www-form-urlencoded'
  )
  const rotated = await oauth.refresh({ metadata, clientId, refreshToken: tokens.refreshToken })
  assert.notEqual(rotated.accessToken, tokens.accessToken)
  await assert.rejects(oauth.refresh({ metadata, clientId, refreshToken: tokens.refreshToken }), /invalid_grant/)
})

test('a refused authorization and a forged callback both fail the sign-in', async (t) => {
  const server = await startAuthorizationServer()
  t.after(server.close)
  const metadata = await oauth.discover(server.issuer)
  const clientId = await oauth.registerClient(metadata)
  await assert.rejects(
    oauth.authorize({
      metadata,
      clientId,
      resource: 'https://relay.example.test/elsewhere',
      scopes: ['ahp'],
      openUrl: browser
    }),
    /invalid_target/
  )
  const forged = (url) => fetch(`${new URL(url).searchParams.get('redirect_uri')}?code=stolen&state=wrong`)
  await assert.rejects(
    oauth.authorize({ metadata, clientId, resource: RESOURCE, scopes: ['ahp'], openUrl: forged }),
    /unexpected response/
  )
  assert.equal(server.codes.size, 0)
})

test('the extension registers for the advertised server and serves the session VS Code asks for', async (t) => {
  const server = await startAuthorizationServer()
  t.after(server.close)
  const advertised = {
    resource: RESOURCE,
    authorization_servers: [server.issuer],
    scopes_supported: ['ahp'],
    required: true
  }
  const realSocket = globalThis.WebSocket
  globalThis.WebSocket = fakeRelaySocket(advertised)
  t.after(() => (globalThis.WebSocket = realSocket))

  const commands = new Map()
  const registrations = []
  const secrets = new Map()
  const state = new Map()
  class EventEmitter {
    listeners = []
    event = (listener) => (this.listeners.push(listener), { dispose() {} })
    fire = (value) => this.listeners.forEach((listener) => listener(value))
    dispose() {}
  }
  const Uri = { parse: (value) => ({ toString: () => value }) }
  const vscode = {
    EventEmitter,
    Uri,
    ProgressLocation: { Notification: 15 },
    authentication: {
      registerAuthenticationProvider: (id, _label, provider, options) => {
        const entry = { id, provider, servers: options.supportedAuthorizationServers.map(String), disposed: false }
        registrations.push(entry)
        return { dispose: () => (entry.disposed = true) }
      }
    },
    commands: {
      registerCommand: (id, run) => (commands.set(id, run), { dispose() {} }),
      executeCommand: (id) => commands.get(id)()
    },
    env: { openExternal: (uri) => browser(uri.toString()) },
    window: {
      createOutputChannel: () => ({ info() {}, warn() {}, error: (error) => assert.fail(error), dispose() {} }),
      withProgress: (_options, work) => work({}, { onCancellationRequested() {} }),
      showErrorMessage: (message) => assert.fail(message),
      showWarningMessage: async () => undefined
    },
    workspace: {
      getConfiguration: () => ({
        get: (key) => (key === 'chat.remoteAgentHosts' ? [{ name: 'test', address: ENDPOINT }] : undefined)
      }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    }
  }
  const load = Module._load
  Module._load = (request, ...rest) => (request === 'vscode' ? vscode : load(request, ...rest))
  t.after(() => (Module._load = load))
  const context = {
    subscriptions: [],
    secrets: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => void secrets.set(key, value),
      onDidChange: () => ({ dispose() {} })
    },
    globalState: { get: (key) => state.get(key), update: async (key, value) => void state.set(key, value) }
  }
  delete require.cache[require.resolve('../extension')]
  await require('../extension').activate(context)
  t.after(() => context.subscriptions.forEach((item) => item.dispose()))

  const live = () => registrations.find((entry) => !entry.disposed)
  assert.deepEqual(live().servers, [server.issuer])
  const asVsCode = () => live().provider.getSessions(['ahp'], { authorizationServer: Uri.parse(`${server.issuer}/`) })
  assert.deepEqual(await asVsCode(), [])

  await commands.get('agentconnect.signIn')()
  const [session] = await asVsCode()
  assert.match(session.accessToken, /^access-/)
  assert.deepEqual(session.scopes, ['ahp'])
  assert.equal(session.id, RESOURCE)
  assert.deepEqual(await live().provider.getSessions(['mcp:read'], {}), [])
  assert.equal(Object.keys(state.get('agentconnect.clients')).length, 1)

  // A token inside the refresh margin is rotated before VS Code receives it.
  const [record] = JSON.parse(secrets.get('agentconnect.sessions'))
  secrets.set('agentconnect.sessions', JSON.stringify([{ ...record, expiresAt: Date.now() + 1000 }]))
  const [refreshed] = await asVsCode()
  assert.notEqual(refreshed.accessToken, session.accessToken)

  await commands.get('agentconnect.signOut')()
  assert.deepEqual(await asVsCode(), [])
})

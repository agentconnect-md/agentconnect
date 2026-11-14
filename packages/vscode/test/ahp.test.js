'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const ahp = require('../lib/ahp')

const ENDPOINT = 'wss://relay.example.test/ahp/agents/11111111-2222-3333-4444-555555555555'

/** A WebSocket whose peer answers each request from `answers`, recording what it was asked. */
function fakeHost(answers, asked = []) {
  return class extends EventTarget {
    constructor() {
      super()
      queueMicrotask(() => this.dispatchEvent(new Event('open')))
    }
    send(text) {
      const { id, method, params } = JSON.parse(text)
      asked.push({ method, params })
      const answer = answers[method]?.(params) ?? { result: {} }
      queueMicrotask(() =>
        this.dispatchEvent(
          Object.assign(new Event('message'), { data: JSON.stringify({ jsonrpc: '2.0', id, ...answer }) })
        )
      )
    }
    close() {}
  }
}

test('the authority matches the one VS Code derives for an address', () => {
  assert.equal(agentHostAuthorityOf('ws://127.0.0.1:8080'), '127.0.0.1__8080')
  assert.equal(agentHostAuthorityOf('localhost'), 'localhost')
  assert.equal(agentHostAuthorityOf(ENDPOINT), `hex-${Buffer.from(ENDPOINT).toString('hex')}`)
  assert.equal(
    agentHostAuthorityOf('ws://127.0.0.1:8080/ahp/agents/a'),
    `hex-${Buffer.from('127.0.0.1:8080/ahp/agents/a').toString('hex')}`
  )
})
const agentHostAuthorityOf = ahp.agentHostAuthority

test('a host directory becomes the agent-host URI VS Code serves it under', () => {
  const folder = ahp.hostFolder(ENDPOINT, 'file:///work/my%20repo')
  assert.equal(folder.scheme, 'vscode-agent-host')
  assert.equal(folder.path, '/work/my repo')
  assert.deepEqual(JSON.parse(Buffer.from(folder.query.slice('_ah='.length), 'base64url').toString()), {
    scheme: 'file'
  })
  assert.throws(() => ahp.hostFolder(ENDPOINT, 'https://example.test/work'), /Not a file location/)
})

test('sessions are listed with their working directories after authenticating', async () => {
  const asked = []
  const WebSocketImpl = fakeHost(
    {
      listSessions: () => ({
        result: { items: [{ resource: 'ahp-session:/one', title: 'Fix retry' }, { resource: 'ahp-session:/two' }] }
      }),
      subscribe: ({ channel }) =>
        channel === 'ahp-session:/one'
          ? { result: { snapshot: { state: { workingDirectories: ['file:///work/one'] } } } }
          : { error: { code: -32008, message: 'Channel not found' } }
    },
    asked
  )
  assert.deepEqual(
    await ahp.sessionWorkspaces({
      endpoint: ENDPOINT,
      resource: 'https://relay.example.test/r',
      token: 't',
      WebSocketImpl
    }),
    [{ session: 'ahp-session:/one', title: 'Fix retry', directories: ['file:///work/one'] }]
  )
  assert.deepEqual(
    asked.map((entry) => entry.method),
    ['initialize', 'authenticate', 'listSessions', 'subscribe', 'subscribe']
  )
  assert.deepEqual(asked[1].params, { channel: 'ahp-root://', resource: 'https://relay.example.test/r', token: 't' })
})

test('a refused sign-in fails the listing', async () => {
  const WebSocketImpl = fakeHost({
    authenticate: () => ({ error: { code: -32007, message: 'Authentication required' } })
  })
  await assert.rejects(
    ahp.sessionWorkspaces({ endpoint: ENDPOINT, resource: 'r', token: 'bad', WebSocketImpl }),
    /Authentication required/
  )
})

'use strict'
// A minimal AHP client and VS Code's agent-host URI shape; no `vscode` import, so `node --test` covers it.
const crypto = require('node:crypto')

/** VS Code's authority for a remote agent host address, as its `agentHostAuthority` derives it. */
function agentHostAuthority(address) {
  const normalized = address.startsWith('ws://') ? address.slice('ws://'.length) : address
  if (/^[a-z0-9]+$/.test(normalized)) return normalized
  if (/^[a-z0-9.:-]+$/.test(normalized) && !/^hex-/i.test(normalized)) return normalized.replaceAll(':', '__')
  return `hex-${Buffer.from(normalized).toString('hex')}`
}

/** The parts of the `vscode-agent-host:` URI under which VS Code serves a host-side `file:` directory. */
function hostFolder(address, directory) {
  const url = new URL(directory)
  if (url.protocol !== 'file:') throw new Error(`Not a file location: ${directory}`)
  return {
    scheme: 'vscode-agent-host',
    authority: agentHostAuthority(address),
    path: decodeURIComponent(url.pathname),
    query: `_ah=${Buffer.from(JSON.stringify({ scheme: 'file' })).toString('base64url')}`
  }
}

/** Lists the caller's sessions on one agent endpoint with the directories each one works in. */
function sessionWorkspaces({ endpoint, resource, token, timeoutMs = 15_000, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(endpoint)
    const waiting = new Map()
    let next = 0
    const finish = (settle, value) => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closed.
      }
      settle(value)
    }
    const timer = setTimeout(() => finish(reject, new Error(`No answer from ${endpoint}`)), timeoutMs)
    const call = (method, params) =>
      new Promise((answer, refuse) => {
        const id = ++next
        waiting.set(id, { answer, refuse })
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      })
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      const pending = waiting.get(message.id)
      if (!pending) return
      waiting.delete(message.id)
      if (message.error) pending.refuse(new Error(message.error.message ?? 'Request refused'))
      else pending.answer(message.result ?? {})
    })
    socket.addEventListener('error', () => finish(reject, new Error(`Could not connect to ${endpoint}`)))
    socket.addEventListener('close', () => finish(reject, new Error(`${endpoint} closed before answering`)))
    socket.addEventListener('open', () => {
      void (async () => {
        // A relay accepts `authenticate` only for the resource it advertised with the root snapshot.
        await call('initialize', {
          channel: 'ahp-root://',
          clientId: crypto.randomUUID(),
          protocolVersions: ['1.0.0'],
          initialSubscriptions: ['ahp-root://']
        })
        if (token) await call('authenticate', { channel: 'ahp-root://', resource, token })
        const { items = [] } = await call('listSessions', { channel: 'ahp-root://', limit: 10 })
        const sessions = []
        for (const item of items) {
          const { snapshot } = await call('subscribe', { channel: item.resource }).catch(() => ({}))
          const directories = snapshot?.state?.workingDirectories ?? []
          if (directories.length)
            sessions.push({ session: item.resource, title: item.title ?? 'Conversation', directories })
        }
        finish(resolve, sessions)
      })().catch((error) => finish(reject, error))
    })
  })
}

module.exports = { agentHostAuthority, hostFolder, sessionWorkspaces }

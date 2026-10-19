import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { parseArgs } from 'node:util'
import { ActionType, MessageKind, ResponsePartKind, chatReducer } from '@microsoft/agent-host-protocol'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'
import { WebSocket } from 'ws'

const root = 'ahp-root://'
await run().catch(() => {
  // Do not print transport errors, upgrade headers, URLs or server-supplied rejection text.
  console.error('AHP request failed or timed out. Check service availability and authorization. No action was retried.')
  console.error('A disconnected request may still be running; inspect the reported session before submitting again.')
  process.exitCode = 1
})

async function run() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean' },
      session: { type: 'string' },
      message: { type: 'string' },
      timeout: { type: 'string', default: '60' }
    }
  })
  if (values.help) {
    console.log('AHP_URL and AHP_API_KEY are required. No arguments lists sessions.')
    console.log('--message TEXT creates a session; --session URI resumes that session.')
    console.log('--timeout SECONDS bounds the run (default 60). No automatic retries or approvals.')
    return
  }
  const url = new URL(process.env.AHP_URL ?? '')
  const token = process.env.AHP_API_KEY
  const timeout = Number(values.timeout)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    !token ||
    /[\r\n]/.test(token) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(url.protocol === 'wss:' || (url.protocol === 'ws:' && loopback)) ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 3600 ||
    (values.message !== undefined && !values.message.trim())
  )
    throw new Error('Invalid configuration')
  // Node ws supplies upgrade headers; protocol messages and reducers still use the official SDK.
  const socket = new WebSocket(url, ['ahp'], {
    headers: { Authorization: `Bearer ${token}` },
    maxPayload: 64 * 1024,
    handshakeTimeout: 10_000,
    followRedirects: false
  })
  let client
  const stop = () => socket.terminate()
  const deadline = setTimeout(stop, timeout * 1000)
  process.once('SIGINT', stop)
  socket.on('error', () => {})
  socket.on('unexpected-response', (_request, response) => {
    response.resume()
    socket.terminate()
  })
  try {
    await once(socket, 'open')
    if (socket.protocol !== 'ahp') throw new Error('Protocol negotiation failed')
    client = new AhpClient(WebSocketTransport.fromSocket(socket), { requestTimeoutMs: 10_000 })
    client.connect()
    const clientId = randomUUID()
    const initialized = await client.initialize({ clientId, protocolVersions: ['1.0.0'], initialSubscriptions: [root] })
    const provider = initialized.snapshots?.find((snapshot) => snapshot.resource === root)?.state.agents?.[0]?.provider
    if (!provider) throw new Error('Agent unavailable')
    let session = values.session
    if (!session && values.message === undefined) {
      const page = await client.request('listSessions', { channel: root, limit: 20 })
      print({ type: 'sessions', items: page.items, nextCursor: page.nextCursor })
      return
    }
    const create = !session
    session ??= `ahp-session:/${randomUUID()}`
    // Report the chosen URI before create so a lost receipt can be reconciled without choosing another identity.
    print({ type: 'session', uri: session })
    if (create) await client.request('createSession', { channel: session, provider })
    const selected = await client.subscribe(session)
    const chat = selected.result.snapshot?.state.defaultChat
    if (!chat) throw new Error('Chat unavailable')
    const { result, subscription } = await client.subscribe(chat)
    let state = result.snapshot?.state
    if (!state || !Array.isArray(state.turns)) throw new Error('Chat snapshot unavailable')
    if (values.message === undefined) {
      print({ type: 'history', turns: state.turns, nextCursor: state.turnsNextCursor })
      return
    }
    const turnId = randomUUID()
    const sent = client.dispatch(chat, {
      type: ActionType.ChatTurnStarted,
      turnId,
      startedAt: new Date().toISOString(),
      message: { text: values.message, origin: { kind: MessageKind.User } }
    })
    let previous = ''
    for await (const event of subscription) {
      if (event.type === 'authRequired') throw new Error('Authorization expired')
      if (event.type !== 'action') continue
      const envelope = event.params
      if (envelope.rejectionReason) {
        if (envelope.origin?.clientId === clientId && envelope.origin.clientSeq === sent.clientSeq)
          throw new Error('Action refused')
        continue
      }
      state = chatReducer(state, envelope.action)
      const turn = state.activeTurn?.id === turnId ? state.activeTurn : state.turns.find((item) => item.id === turnId)
      if (!turn) continue
      const text = turn.responseParts
        .filter((part) => part.kind === ResponsePartKind.Markdown)
        .map((part) => part.content)
        .join('\n')
      if (text !== previous) {
        print({ type: 'output', turnId, text })
        previous = text
      }
      if (state.activeTurn?.id !== turnId) {
        print({ type: 'complete', turnId, state: turn.state })
        return
      }
    }
    throw new Error('Connection ended before completion')
  } finally {
    clearTimeout(deadline)
    process.removeListener('SIGINT', stop)
    await client?.shutdown()
    socket.terminate()
  }
}
function print(value) {
  console.log(JSON.stringify(value))
}

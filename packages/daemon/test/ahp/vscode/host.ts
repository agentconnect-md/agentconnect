// A real Daemon with AHP on and a scripted ACP runtime, served on a local WebSocket for an external AHP client such as VS Code.
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import type {
  AhpAttachmentAuthorization,
  AhpSessionBinding,
  RdAhpClose,
  RdAhpMessage,
  RdAhpOpen
} from '@agentconnect.md/protocol'
import { createAhpServer } from '../../../../relay/src/ahp-server.js'
import type { RelayDaemonConnection } from '../../../../relay/src/relay-daemon-connection.js'
import { Daemon } from '../../../src/daemon.js'
import type { AhpService, AhpServiceOptions } from '../../../src/ahp/service.js'

const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const orgId = 'fixture-org'
type Internals = {
  ahp: AhpService
  cpClient: unknown
  cpCollab: { replace(directory: unknown): void }
}
type Frame =
  | { dir: 'in'; id?: string | number; method: string; channel?: string; action?: string }
  | {
      dir: 'out'
      id?: string | number
      method?: string
      action?: string
      error?: { code: number; message: string }
      /** Content references a file edit carries: identifiers, which a client reads back with `resourceRead`. */
      contentRefs?: string[]
    }
/** One frame without its payload; `connection` counts sockets, since request ids restart on each. */
export type HostRecord = Frame & { at: number; connection: number }

// The control-plane metadata boundary, scripted as in the daemon acceptance test.
function registry(): AhpServiceOptions['registry'] {
  const bindings = new Map<string, AhpSessionBinding>()
  const allowed = (scope: { orgId: string; agentId: string; grant: string }) =>
    scope.orgId === orgId && scope.agentId === agentId && scope.grant === 'fixture-grant'
  return {
    reserve: async (input) => {
      if (!allowed(input)) return { ok: false, reason: 'forbidden' }
      let binding = bindings.get(input.sessionUri)
      if (!binding) {
        binding = {
          sessionUri: input.sessionUri,
          reservationId: randomUUID(),
          conversationId: randomUUID(),
          callerRole: 'owner',
          callerApproves: true
        }
        bindings.set(input.sessionUri, binding)
      }
      return { ok: true, ...binding }
    },
    finalize: async (input) => {
      const binding = [...bindings.values()].find((entry) => entry.reservationId === input.reservationId)
      if (!binding || !allowed(input)) return { ok: false, reason: 'forbidden' }
      binding.sessionId = input.sessionId
      return { ok: true, ...binding }
    },
    resolve: async (input) => {
      const binding = bindings.get(input.sessionUri)
      return allowed(input) && binding ? { ok: true, ...binding } : { ok: false, reason: 'not_found' }
    },
    list: async (input) =>
      allowed(input)
        ? { ok: true, sessions: [...bindings.values()].filter((binding) => binding.sessionId) }
        : { ok: false, reason: 'forbidden' }
  }
}
const authorization = (): AhpAttachmentAuthorization => ({
  orgId,
  agentId,
  userId: 'fixture-user',
  user: 'Fixture user',
  callerRole: 'owner',
  callerApproves: true,
  grant: { token: 'fixture-grant', expiresAtMs: Date.now() + 24 * 3600_000 }
})

/** What one JSON-RPC text frame is, without its payload: enough to see which methods a client needs. */
function describe(dir: 'in' | 'out', text: string): Frame | undefined {
  let message: {
    id?: string | number
    method?: string
    params?: { channel?: string; action?: { type?: string } }
    error?: { code: number; message: string }
  }
  try {
    message = JSON.parse(text)
  } catch {
    return undefined
  }
  const action = message.params?.action?.type
  if (dir === 'in')
    return message.method
      ? { dir, id: message.id, method: message.method, channel: message.params?.channel, action }
      : undefined
  const contentRefs = [...new Set(text.match(/session-db:\/\/[^"\\]+/g) ?? [])]
  if (message.method) return { dir, method: message.method, action, ...(contentRefs.length ? { contentRefs } : {}) }
  return { dir, id: message.id, ...(message.error ? { error: message.error } : {}) }
}

/** With `signIn`, the relay's own AHP endpoint fronts the daemon: clients authenticate in-band with a token `accepts` admits. */
export async function startVsCodeHost(
  options: { port?: number; logPath?: string; signIn?: { issuer: string; accepts(token: string): boolean } } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'ahp-vscode-host-'))
  const script = join(root, 'acp-agent.mjs')
  copyFileSync(fileURLToPath(new URL('../../fixtures/ahp-acp-agent.mjs', import.meta.url)), script)
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { ahp: { mode: 'on' } },
      runtimes: { fixture: { command: process.execPath, args: [script, join(root, 'runtime.jsonl')] } }
    })
  )
  const agentDir = join(root, 'agents', agentId)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: agentId,
      name: 'VS Code fixture',
      status: 'active',
      runtime: 'fixture',
      workspace: { mode: 'from-scratch', path: join(agentDir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  const daemon = new Daemon({ root })
  await daemon.start()
  const internal = daemon as unknown as Internals
  const metadata = registry()
  internal.cpClient = {
    ahpSessionReserve: metadata.reserve,
    ahpSessionFinalize: metadata.finalize,
    ahpSessionResolve: metadata.resolve,
    ahpSessionList: metadata.list,
    organizationScope: () => 'connection',
    memberSet: () => undefined,
    emitUsageReport: () => {},
    emitSessionActivity: () => {},
    emitAgentActivity: () => {},
    emitEventSession: () => {},
    stop: async () => {}
  }
  internal.cpCollab.replace({
    generation: 1,
    channels: [],
    agents: [
      {
        orgId,
        agentId,
        daemonId: 'fixture-daemon',
        name: 'VS Code fixture',
        callPolicy: 'all',
        allowedCallerAgentIds: [],
        outboundPolicy: 'all',
        allowedTargetAgentIds: []
      }
    ]
  })
  const records: HostRecord[] = []
  let connections = 0
  const record = (connection: number, dir: 'in' | 'out', text: string) => {
    const frame = describe(dir, text)
    if (!frame) return
    const entry = { ...frame, at: Date.now(), connection }
    records.push(entry)
    if (options.logPath) appendFileSync(options.logPath, `${JSON.stringify(entry)}\n`)
  }
  const stops: Array<() => void> = []
  let server: { address(): string | AddressInfo | null; close(done: () => void): void }
  if (options.signIn) {
    const signIn = options.signIn
    const connectionId = randomUUID()
    const numbers = new Map<string, number>()
    const number = (attachmentId: string) =>
      numbers.get(attachmentId) ?? numbers.set(attachmentId, ++connections).get(attachmentId)!
    const listeners = new Map<string, (frame: RdAhpMessage | RdAhpClose) => void>()
    // The daemon hop of the relay, in process: what `rd/ahp-*` frames carry in a deployment.
    const carrier = {
      state: 'READY',
      supports: () => true,
      // The relay renews a grant every minute with the same call, without `initial`.
      authorizeAhp: (input: RdAhpOpen, initial = false) =>
        initial
          ? internal.ahp.open(
              input,
              {
                send: (message) => {
                  record(number(input.attachmentId), 'out', message)
                  listeners.get(input.attachmentId)?.({ attachmentId: input.attachmentId, message })
                },
                close: (reason) => listeners.get(input.attachmentId)?.({ attachmentId: input.attachmentId, reason })
              },
              connectionId
            )
          : internal.ahp.authorize(input, connectionId),
      sendAhp: (frame: RdAhpMessage | RdAhpClose) => {
        if ('message' in frame) {
          record(number(frame.attachmentId), 'in', frame.message)
          void internal.ahp.receive(frame, connectionId)
        } else internal.ahp.close(frame, connectionId)
      },
      listenAhp: (id: string, listener: (frame: RdAhpMessage | RdAhpClose) => void) => {
        listeners.set(id, listener)
        return () => listeners.delete(id)
      },
      onceClosed: () => () => {}
    } as unknown as RelayDaemonConnection
    const http = createServer()
    const edge = createAhpServer({ server: http } as Parameters<typeof createAhpServer>[0], {
      mode: () => 'on',
      authorizationServer: signIn.issuer,
      daemon: () => carrier,
      verify: async (credential, verifiedAgent) => {
        const { grant, ...caller } = authorization()
        return signIn.accepts(credential) && verifiedAgent === agentId
          ? {
              ok: true,
              ...caller,
              daemonId: randomUUID(),
              apiProtocols: ['ahp'],
              ahpGrant: { ...grant, expiresAtMs: Date.now() + 55_000 }
            }
          : { ok: false, reason: 'forbidden' }
      }
    })
    http.listen(options.port ?? 0, '127.0.0.1')
    await once(http, 'listening')
    stops.push(() => {
      for (const socket of edge.wss.clients) socket.terminate()
      edge.close()
    })
    server = http
  } else {
    const direct = new WebSocketServer({ host: '127.0.0.1', port: options.port ?? 0, maxPayload: 1024 * 1024 })
    await once(direct, 'listening')
    direct.on('connection', (socket) => {
      const attachmentId = randomUUID()
      const connectionId = randomUUID()
      const connection = ++connections
      const opened = internal.ahp.open(
        { attachmentId, authorization: authorization() },
        {
          send: (message) => {
            record(connection, 'out', message)
            socket.send(message)
          },
          close: () => socket.close()
        },
        connectionId
      )
      socket.on('message', (data) => {
        const text = data.toString()
        record(connection, 'in', text)
        void opened
          .then((ok) => (ok ? internal.ahp.receive({ attachmentId, message: text }, connectionId) : socket.close()))
          .catch(() => socket.close())
      })
      socket.on('close', () => internal.ahp.close({ attachmentId, reason: 'client_closed' }, connectionId))
      void opened.then((ok) => ok || socket.close()).catch(() => socket.close())
    })
    stops.push(() => {
      for (const socket of direct.clients) socket.terminate()
    })
    server = direct
  }
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  return {
    agentId,
    records,
    /** The agent's workspace as the daemon publishes it; it exists once a turn has run. */
    workspace: () => realpathSync(join(agentDir, 'workspace')),
    url: `ws://127.0.0.1:${address.port}/ahp/agents/${agentId}`,
    stop: async () => {
      for (const stop of stops) stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = await startVsCodeHost({
    port: Number(process.env.AHP_HOST_PORT ?? 0),
    logPath: process.env.AHP_HOST_LOG
  })
  console.log(`READY ${host.url}`)
  const stop = () => void host.stop().finally(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

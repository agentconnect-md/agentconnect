import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { RELAY_CP_SUBPROTOCOL, type RdAgentMsgAck } from '@agentconnect.md/protocol'
import type { PrismaClient } from '../../src/generated/prisma/client.js'
import { buildApp, type App } from '../../src/app.js'
import { AppConfigSchema } from '../../src/config/env.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import { MemorySecretsProvider } from '../../src/secrets/providers/memory.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { Daemon } from '../../../daemon/src/daemon.js'
import { ClientTransport, systemClock } from '../../../connection/src/index.js'
import { buildRelayServer } from '../../../relay/src/server.js'
import { RelayCpClient } from '../../../relay/src/relay-cp-client.js'
import { createRelayDaemonServer, type RelayDaemonServer } from '../../../relay/src/relay-daemon-server.js'
import { createRelayBrowserServer } from '../../../relay/src/relay-browser-server.js'
import { WebchatRouter } from '../../../relay/src/webchat-router.js'
import type { Logger as RelayLogger } from '../../../relay/src/log.js'

const DAEMON_ID = 'd1515151-1515-4151-8151-151515151515'
const PRESET_AGENT_ID = 'a1515151-1515-4151-8151-151515151515'
const OTHER_AGENT_ID = 'a2525252-2525-4252-8252-252525252525'
const API_KEY_PEPPER = 'webchat-e2e-pepper-0123456789abcdef'
const RELAY_TOKEN = 'webchat-e2e-relay-token-0123456789abcdef'
const AGENT_SECRET = 'webchat-e2e-agent-secret-must-never-leak'
const RELAY_NAME = 'webchat-preset-mcp-e2e'
const RUNTIME = 'delegated-mcp-e2e'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const acpFixture = join(repoRoot, 'packages/daemon/test/fixtures/delegated-mcp-acp-agent.mjs')
const daemonEntry = join(repoRoot, 'packages/daemon/dist/index.js')
const silentLog: RelayLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

type BrowserFrame = {
  type?: string
  output?: {
    turnId?: string
    event?: { kind?: string; text?: string }
  }
  done?: { turnId?: string }
  ack?: { turnId?: string; accepted?: boolean; reason?: string }
}

export interface WebchatTurnResult {
  turnId: string
  text: string
}

export interface WebchatBrowser {
  turn(text: string): Promise<WebchatTurnResult>
  isOpen(): boolean
}

export interface WebchatPresetMcpStack {
  readonly presetAgentId: string
  readonly otherAgentId: string
  readonly conversationId: string
  readonly secretSentinels: readonly string[]
  openBrowser(): Promise<WebchatBrowser>
  stopControlPlane(): Promise<void>
  close(): Promise<void>
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function websocketClosed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

class BufferedBrowser implements WebchatBrowser {
  private readonly frames: BrowserFrame[] = []
  private waiter?: () => void

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: Buffer) => {
      this.frames.push(JSON.parse(data.toString('utf8')) as BrowserFrame)
      this.waiter?.()
      this.waiter = undefined
    })
  }

  async ready(): Promise<void> {
    await this.next((frame) => frame.type === 'ready', 'ready')
  }

  isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  async turn(text: string): Promise<WebchatTurnResult> {
    const turnId = randomUUID()
    this.socket.send(JSON.stringify({ type: 'message', turnId, text }))
    const ack = await this.next((frame) => frame.type === 'ack' && frame.ack?.turnId === turnId, `ack for ${turnId}`)
    if (!ack.ack?.accepted) throw new Error(`webchat turn refused: ${ack.ack?.reason ?? 'unknown'}`)

    const chunks: string[] = []
    for (;;) {
      const frame = await this.next(
        (candidate) =>
          (candidate.type === 'output' && candidate.output?.turnId === turnId) ||
          (candidate.type === 'done' && candidate.done?.turnId === turnId),
        `output or done for ${turnId}`
      )
      if (frame.type === 'done') return { turnId, text: chunks.join('') }
      if (frame.output?.event?.kind === 'message' && frame.output.event.text) {
        chunks.push(frame.output.event.text)
      }
    }
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return
    const closed = websocketClosed(this.socket)
    this.socket.close()
    await closed
  }

  private async next(predicate: (frame: BrowserFrame) => boolean, label: string): Promise<BrowserFrame> {
    const deadline = Date.now() + 20_000
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      if (this.socket.readyState === WebSocket.CLOSED) throw new Error(`browser closed waiting for ${label}`)
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timed out waiting for browser ${label}`)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.waiter === wake) this.waiter = undefined
          reject(new Error(`timed out waiting for browser ${label}`))
        }, remaining)
        const wake = () => {
          clearTimeout(timer)
          resolve()
        }
        this.waiter = wake
      })
    }
  }
}

async function closeWss(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate()
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
}

export async function startWebchatPresetMcpStack(prisma: PrismaClient): Promise<WebchatPresetMcpStack> {
  if (process.platform !== 'linux') throw new Error('real delegated MCP E2E requires Linux')
  if (!existsSync(daemonEntry)) {
    throw new Error(`real delegated MCP E2E requires a built daemon entry at ${daemonEntry}`)
  }

  let cp: App | undefined
  let cpStopped = false
  let relay: ReturnType<typeof buildRelayServer> | undefined
  let relayClient: RelayCpClient | undefined
  let rdServer: RelayDaemonServer | undefined
  let browserServer: WebSocketServer | undefined
  let daemon: Daemon | undefined
  let daemonRoot: string | undefined
  const browsers = new Set<BufferedBrowser>()
  const previousDaemonEntry = process.env.AGENTCONNECT_DAEMON_ENTRY
  let disposing = false

  const stopCp = async (): Promise<void> => {
    if (!cp || cpStopped) return
    cp.beginShutdown()
    await cp.drainWs()
    await cp.http.close()
    await cp.shutdown()
    cpStopped = true
  }
  const dispose = async (): Promise<void> => {
    if (disposing) return
    disposing = true
    await Promise.all([...browsers].map((browser) => browser.close().catch(() => {})))
    browsers.clear()
    await daemon?.stop().catch(() => {})
    await relayClient?.stop().catch(() => {})
    if (browserServer) await closeWss(browserServer)
    if (rdServer) await closeWss(rdServer.wss)
    await relay?.close().catch(() => {})
    await stopCp().catch(() => {})
    if (daemonRoot) rmSync(daemonRoot, { recursive: true, force: true })
    if (previousDaemonEntry === undefined) delete process.env.AGENTCONNECT_DAEMON_ENTRY
    else process.env.AGENTCONNECT_DAEMON_ENTRY = previousDaemonEntry
  }

  const codec = new ApiKeyCodec({ API_KEY_PEPPER })
  const daemonKey = codec.mint()
  await prisma.daemon.create({
    data: { id: DAEMON_ID, orgId: DEFAULT_ORG_ID, status: 'provisioned' }
  })
  await prisma.apiKey.create({
    data: {
      principalType: 'daemon',
      orgId: DEFAULT_ORG_ID,
      daemonId: DAEMON_ID,
      hash: daemonKey.hash,
      displayTail: daemonKey.displayTail
    }
  })
  await prisma.agent.createMany({
    data: [
      {
        id: PRESET_AGENT_ID,
        orgId: DEFAULT_ORG_ID,
        name: 'agentconnect',
        displayName: 'AgentConnect',
        runtime: RUNTIME,
        daemonId: DAEMON_ID,
        status: 'active',
        restrictFileAccess: true
      },
      {
        id: OTHER_AGENT_ID,
        orgId: DEFAULT_ORG_ID,
        name: 'delegated-e2e-target',
        runtime: RUNTIME,
        status: 'active'
      }
    ]
  })
  await prisma.presetAgent.create({
    data: {
      orgId: DEFAULT_ORG_ID,
      preset: 'general',
      agentId: PRESET_AGENT_ID,
      status: 'created'
    }
  })
  await prisma.agentSecret.create({
    data: { agentId: OTHER_AGENT_ID, key: 'E2E_PRIVATE_TOKEN', value: AGENT_SECRET }
  })

  try {
    // Listen first so the CP advertises the exact relay endpoint it will actually use.
    relay = buildRelayServer(
      {
        isReady: () => relayClient?.isReady() ?? false,
        relayId: () => relayClient?.relayId
      },
      { logger: false }
    )
    const relayHttp = await relay.listen({ port: 0, host: '127.0.0.1' })
    const relayWs = relayHttp.replace(/^http/, 'ws')

    const cpConfig = AppConfigSchema.parse({
      DATABASE_URL: 'postgresql://webchat-e2e/ignored',
      API_KEY_PEPPER,
      RELAY_TOKEN,
      PUBLIC_RELAY_URL: relayHttp,
      WEBCHAT_PRESET_MCP_ENABLED: 'true',
      SECRETS_PROVIDER: 'memory',
      HEARTBEAT_SEC: 5
    })
    cp = buildApp({
      prisma,
      config: cpConfig,
      clock: systemClock,
      secretsProvider: new MemorySecretsProvider()
    })
    const cpHttp = await cp.http.listen({ port: 0, host: '127.0.0.1' })
    cp.mountWs()
    const cpWs = cpHttp.replace(/^http/, 'ws')
    const router = new WebchatRouter()

    relayClient = new RelayCpClient({
      auth: { method: 'token', credential: RELAY_TOKEN },
      name: RELAY_NAME,
      daemonUrl: relayWs,
      heartbeatDefaultMs: 5_000,
      clock: systemClock,
      connect: () =>
        ClientTransport.dial(cpWs, {
          subprotocol: RELAY_CP_SUBPROTOCOL,
          path: '/api/v1/relays/ws'
        }),
      log: silentLog,
      jitter: () => 0,
      onRevoke: (daemonId) => rdServer?.revoke(daemonId)
    })
    rdServer = createRelayDaemonServer(relay, {
      verify: (kind, credential) => relayClient!.verify(kind, credential),
      relayId: () => relayClient?.relayId,
      clock: systemClock,
      onChat: (chat) => router.deliver(chat),
      onAgentMsg: async (_daemonId, message): Promise<RdAgentMsgAck> => ({
        deliveryId: message.deliveryId,
        delivered: false,
        reason: 'offline'
      }),
      log: silentLog
    })
    browserServer = createRelayBrowserServer(relay, {
      verify: (kind, token) => relayClient!.verify(kind, token),
      daemons: rdServer,
      router,
      log: silentLog
    })
    relayClient.start()
    await waitFor(() => relayClient?.isReady() ?? false, 'relay control registration')

    daemonRoot = mkdtempSync(join(tmpdir(), 'ac-webchat-mcp-stack-'))
    const agentDir = join(daemonRoot, 'agents', PRESET_AGENT_ID)
    const workspace = join(agentDir, 'workspace')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(
      join(daemonRoot, 'config.json'),
      JSON.stringify({
        version: 1,
        controlPlane: {
          enabled: true,
          url: cpWs,
          key: daemonKey.token,
          heartbeatMs: 5_000
        },
        runtimes: {
          [RUNTIME]: {
            command: process.execPath,
            args: [acpFixture],
            env: []
          }
        },
        security: {
          requireSandbox: true,
          isolateAccountApps: true,
          workspaceGitAllowedOrigins: []
        },
        logging: { level: 'error' }
      })
    )
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        id: PRESET_AGENT_ID,
        name: 'agentconnect',
        displayName: 'AgentConnect',
        status: 'active',
        runtime: RUNTIME,
        restrictFileAccess: true,
        workspace: { mode: 'from-scratch', path: workspace },
        integrations: [],
        output: { mode: 'medium' }
      })
    )

    process.env.AGENTCONNECT_DAEMON_ENTRY = daemonEntry
    daemon = new Daemon({
      root: daemonRoot,
      probeRuntimes: async () => []
    })
    await daemon.start()
    await waitFor(() => rdServer?.size() === 1, 'daemon relay registration')
    await waitFor(
      () =>
        ((daemon as unknown as { cpClient?: { isReady(): boolean } }).cpClient?.isReady() ?? false) &&
        ((daemon as unknown as { delegatedMcpBroker?: unknown }).delegatedMcpBroker ?? null) !== null,
      'daemon delegated MCP readiness'
    )

    const minted = await cp.http.inject({
      method: 'POST',
      url: `/api/v1/orgs/${DEFAULT_ORG_ID}/agents/${PRESET_AGENT_ID}/webchat/token`,
      payload: {}
    })
    if (minted.statusCode !== 200) {
      throw new Error(`webchat token mint failed (${minted.statusCode}): ${minted.body}`)
    }
    const token = minted.json() as { token: string; conversationId: string; relayUrl: string }
    if (token.relayUrl !== relayHttp) {
      throw new Error(`webchat token advertised ${token.relayUrl}, expected live relay ${relayHttp}`)
    }
    const liveRelayClient = relayClient
    const liveDaemon = daemon

    return {
      presetAgentId: PRESET_AGENT_ID,
      otherAgentId: OTHER_AGENT_ID,
      conversationId: token.conversationId,
      secretSentinels: [daemonKey.token, RELAY_TOKEN, token.token, AGENT_SECRET],
      async openBrowser(): Promise<WebchatBrowser> {
        const url =
          `${relayWs}/webchat?token=${encodeURIComponent(token.token)}` +
          `&conversation_id=${encodeURIComponent(token.conversationId)}`
        const socket = new WebSocket(url)
        const browser = new BufferedBrowser(socket)
        browsers.add(browser)
        await new Promise<void>((resolveOpen, reject) => {
          socket.once('open', () => resolveOpen())
          socket.once('error', reject)
          socket.once('unexpected-response', (_request, response) =>
            reject(new Error(`browser websocket refused with ${response.statusCode}`))
          )
        })
        await browser.ready()
        return browser
      },
      async stopControlPlane(): Promise<void> {
        await stopCp()
        if (cp?.http.server.listening) throw new Error('control-plane HTTP listener survived shutdown')
        await waitFor(() => !liveRelayClient.isReady(), 'relay control outage')
        await waitFor(
          () => !((liveDaemon as unknown as { cpClient?: { isReady(): boolean } }).cpClient?.isReady() ?? false),
          'daemon control outage'
        )
      },
      close: dispose
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

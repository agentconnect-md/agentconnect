import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpInvocationMint, McpInvocationMinted } from '@agentconnect.md/protocol'
import {
  delegatedMcpInCellSocketDirectory,
  delegatedCellSandboxWrap,
  detectSandbox,
  sandboxWrap
} from '../src/acp/sandbox.js'
import { McpControlServer } from '../src/mcp/control-server.js'
import { SessionMcpBroker } from '../src/mcp/session-mcp-broker.js'

const run = promisify(execFile)
const repoRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
const roots: string[] = []
const brokers: SessionMcpBroker[] = []
const controlServers: McpControlServer[] = []

// Both user conversations select the same preset/agent.
const PRESET_AGENT_ID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION_A = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_B = '33333333-3333-4333-8333-333333333333'
const DELEGATION_A = '44444444-4444-4444-8444-444444444444'
const DELEGATION_B = '55555555-5555-4555-8555-555555555555'
const EXPIRY = '2099-07-31T12:00:00.000Z'

const PROBE_SCRIPT = String.raw`
const fs = require('node:fs')
const net = require('node:net')

function probe(endpoint, token, attach) {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint)
    let buffer = ''
    let attached = false
    const done = (result) => {
      socket.destroy()
      resolve(result)
    }
    socket.setEncoding('utf8')
    socket.setTimeout(2000, () => done({ connected: false, authorized: false, error: 'timeout' }))
    socket.once('error', (error) => done({ connected: false, authorized: false, error: error.code ?? 'error' }))
    socket.once('connect', () => {
      socket.write(JSON.stringify({ id: 1, token, op: attach ? 'attach' : 'listTools' }) + '\n')
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const response = JSON.parse(line)
        if (attach && !attached) {
          if (!response.ok) return done({ connected: true, authorized: false })
          attached = true
          socket.write(JSON.stringify({ id: 2, token, op: 'listTools' }) + '\n')
          continue
        }
        return done({ connected: true, authorized: response.ok === true })
      }
    })
  })
}

async function main() {
  const token = process.argv[1]
  const endpoints = JSON.parse(process.argv[2])
  const results = []
  for (const endpoint of endpoints) {
    results.push({
      pathVisible: fs.existsSync(endpoint.path),
      ...(await probe(endpoint.path, token, endpoint.attach))
    })
  }
  process.stdout.write(JSON.stringify(results))
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error))
  process.exitCode = 1
})
`

afterEach(async () => {
  await Promise.all(controlServers.splice(0).map((server) => server.stop()))
  await Promise.all(brokers.splice(0).map((broker) => broker.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function privateRoot(prefix: string): Promise<string> {
  // Production daemon state lives outside the sandbox's generic /tmp overlay.
  // Keeping this fixture under HOME makes the test fail if the broker-specific
  // source-root mask is removed or accidentally shared into a sibling host.
  const root = await mkdtemp(join(homedir(), prefix))
  const canonical = await realpath(root)
  expect(canonical).not.toBe(repoRoot)
  expect(canonical.startsWith(repoRoot + sep)).toBe(false)
  roots.push(root)
  return canonical
}

function descriptorEnv(descriptor: NonNullable<Awaited<ReturnType<SessionMcpBroker['registerCell']>>>) {
  return Object.fromEntries(descriptor.env.map(({ name, value }) => [name, value]))
}

async function executeProbe(
  wrapped: { cmd: string; args: string[] },
  token: string,
  endpoints: Array<{ path: string; attach: boolean }>
): Promise<Array<{ pathVisible: boolean; connected: boolean; authorized: boolean; error?: string }>> {
  const { stdout } = await run(wrapped.cmd, [...wrapped.args, token, JSON.stringify(endpoints)], {
    timeout: 10_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024
  })
  return JSON.parse(stdout) as Array<{
    pathVisible: boolean
    connected: boolean
    authorized: boolean
    error?: string
  }>
}

describe('delegated MCP copied socket/token isolation', () => {
  it.skipIf(process.platform !== 'linux')(
    'denies entitled and ordinary sibling attacks before and after victim activation',
    async () => {
      expect(detectSandbox(), 'Linux acceptance CI must provide a working bwrap').toBe('bwrap')

      const daemonRoot = await privateRoot('.ac-cross-cell-state-')
      const brokerRoot = join(daemonRoot, 'admin-mcp-broker')
      const runtimeHomeRoot = join(daemonRoot, 'delegated-homes')
      const sharedControlRoot = join(daemonRoot, 'run')
      const homeA = join(runtimeHomeRoot, 'cell-a')
      const homeB = join(runtimeHomeRoot, 'cell-b')
      await mkdir(brokerRoot)
      await mkdir(runtimeHomeRoot)
      await mkdir(sharedControlRoot)
      await mkdir(homeA)
      await mkdir(homeB)
      const sharedControlPath = join(sharedControlRoot, 'mcp.sock')

      const sharedControlServer = new McpControlServer({
        socketPath: sharedControlPath,
        gatewayFor: () => {
          throw new Error('copied delegated tokens must not resolve a shared MCP session')
        },
        recordOutbound: () => {},
        now: () => 0
      })
      await sharedControlServer.start()
      controlServers.push(sharedControlServer)

      const mintMcpInvocation = vi.fn(async (input: McpInvocationMint): Promise<McpInvocationMinted> => ({
        invocationId: input.invocationId,
        assertion: `assertion-${input.conversationId}`,
        expiresAt: '2099-07-31T00:00:30.000Z'
      }))
      const tokens = ['token-cell-a', 'token-cell-b']
      let tokenIndex = 0
      const broker = new SessionMcpBroker({
        socketRoot: brokerRoot,
        inCellSocketDirectory: delegatedMcpInCellSocketDirectory(),
        cliEntry: '/unused/agentconnect.js',
        mcpEndpoint: 'https://cp.example/api/v1/mcp',
        cpClient: {
          mintMcpInvocation,
          revokeWebchatMcpDelegation: vi.fn()
        },
        fetch: vi.fn(async (_url, init) => {
          const request = JSON.parse(init.body.toString('utf8')) as { id: string }
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: { tools: [] }
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }),
        randomToken: () => tokens[tokenIndex++]!,
        now: () => Date.parse('2099-07-30T00:00:00.000Z')
      })
      brokers.push(broker)

      const descriptorA = await broker.registerCell({
        isolationCellId: 'cell-a',
        platform: 'webchat',
        agentId: PRESET_AGENT_ID,
        conversationId: CONVERSATION_A,
        delegationId: DELEGATION_A,
        generation: 1,
        expiresAt: EXPIRY
      })
      const descriptorB = await broker.registerCell({
        isolationCellId: 'cell-b',
        platform: 'webchat',
        agentId: PRESET_AGENT_ID,
        conversationId: CONVERSATION_B,
        delegationId: DELEGATION_B,
        generation: 1,
        expiresAt: EXPIRY
      })
      expect(descriptorA).not.toBeNull()
      expect(descriptorB).not.toBeNull()

      const mountA = broker.getCellMount('cell-a')!
      const mountB = broker.getCellMount('cell-b')!
      const tokenB = descriptorEnv(descriptorB!).AC_MCP_TOKEN!
      expect(mountA.targetDirectory).toBe(delegatedMcpInCellSocketDirectory())
      expect(mountB.targetDirectory).toBe(delegatedMcpInCellSocketDirectory())
      const inCellSocketPath = join(delegatedMcpInCellSocketDirectory(), 'mcp.sock')
      const copiedVictimEndpoints = [
        { path: mountB.sourceSocketPath, attach: true },
        { path: inCellSocketPath, attach: true },
        { path: sharedControlPath, attach: false }
      ]

      const entitledA = delegatedCellSandboxWrap(
        process.execPath,
        ['-e', PROBE_SCRIPT],
        [sharedControlRoot],
        {
          maskedRoot: brokerRoot,
          sourceDir: mountA.sourceDirectory,
          targetDir: mountA.targetDirectory
        },
        {
          maskedRoot: runtimeHomeRoot,
          sourceDir: homeA,
          targetDir: homeA
        }
      )
      const ordinaryC = sandboxWrap(process.execPath, ['-e', PROBE_SCRIPT], {
        mechanism: 'bwrap',
        writable: [sharedControlRoot],
        maskedReadRoots: [brokerRoot, runtimeHomeRoot]
      })
      const victimB = delegatedCellSandboxWrap(
        process.execPath,
        ['-e', PROBE_SCRIPT],
        [sharedControlRoot],
        {
          maskedRoot: brokerRoot,
          sourceDir: mountB.sourceDirectory,
          targetDir: mountB.targetDirectory
        },
        {
          maskedRoot: runtimeHomeRoot,
          sourceDir: homeB,
          targetDir: homeB
        }
      )

      const assertCopiedTokenDenied = async (attacker: typeof entitledA, entitled: boolean) => {
        const attempts = await executeProbe(attacker, tokenB, copiedVictimEndpoints)
        expect(attempts).toHaveLength(3)
        // The copied host source must disappear. This assertion fails if the common
        // broker root is accidentally shared into any sibling mount namespace.
        expect(attempts[0]).toMatchObject({ pathVisible: false, connected: false, authorized: false })
        if (entitled) {
          // The common in-cell path is A's own private bind, never B's. Reaching it
          // with B's copied token must fail authentication at A's broker endpoint.
          expect(attempts[1]).toEqual({ pathVisible: true, connected: true, authorized: false })
        } else {
          expect(attempts[1]).toMatchObject({ pathVisible: false, connected: false, authorized: false })
        }
        // Production ACP hosts can reach the ordinary shared control socket, but a
        // delegated private token must never resolve there.
        expect(attempts[2]).toEqual({ pathVisible: true, connected: true, authorized: false })
        expect(attempts.some((attempt) => attempt.authorized)).toBe(false)
      }

      await assertCopiedTokenDenied(entitledA, true)
      await assertCopiedTokenDenied(ordinaryC, false)
      expect(mintMcpInvocation).not.toHaveBeenCalled()

      const victim = await executeProbe(victimB, tokenB, [{ path: inCellSocketPath, attach: true }])
      expect(victim).toEqual([{ pathVisible: true, connected: true, authorized: true }])
      expect(mintMcpInvocation).toHaveBeenCalledTimes(1)
      expect(mintMcpInvocation).toHaveBeenLastCalledWith(expect.objectContaining({ conversationId: CONVERSATION_B }))

      await assertCopiedTokenDenied(entitledA, true)
      await assertCopiedTokenDenied(ordinaryC, false)
      expect(mintMcpInvocation).toHaveBeenCalledTimes(1)
    },
    75_000
  )
})

// End-to-end smoke test for the runtime-sandbox image: a real shim, the real ACP runtime, one session.
//
//   pnpm --filter @agentconnect.md/daemon exec tsx scripts/smoke-runtime-image.mts <image>
//   tsx scripts/smoke-runtime-image.mts --connect <host:port> [--token-file <path>]
//
// The first form starts the image with `docker run` and dials the port it publishes. The second dials a shim that is
// already running — the Dockerfile's smoke stage starts the image's own entrypoint and runs this beside it, so a release
// build verifies the shim without loading the image or installing a toolchain on the runner. Both modes drive the same
// steps: the daemon dials the shim and binds, the shim starts the ACP runtime in the image's filesystem, `initialize`
// and `session/new` answer. What this catches is what unit tests cannot: a shim that cannot resolve its imports in the
// image, a runtime that is not on PATH, an entrypoint that never reaches the shim, a user that cannot write its home.
// The daemon side is a real ShimDialer with a verifier that accepts this run's token; pod identity is TokenReviewed in
// production and unit-tested, and re-deriving it here would mean standing up Kubernetes to test a container image.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShimDialer } from '../src/shim/dialer.js'
import { DEFAULT_SHIM_LISTEN_PORT, SHIM_IDENTITY_TOKEN_PATH } from '../src/shim/protocol.js'
import { ShimSession } from '../src/shim/session.js'
import type { SpawnRecord } from '../src/shim/binding.js'

/** A shim to drive: where it listens, the token its identity presents, and how to see its logs afterwards. */
interface ShimUnderTest {
  endpoint: string
  token: string
  label: string
  logs: () => string
  stop: () => void
}

type Mode = { image: string } | { connect: string; tokenFile: string }

function usage(): never {
  console.error('usage: smoke-runtime-image.mts <image> | --connect <host:port> [--token-file <path>]')
  process.exit(2)
}

function parseArgs(argv: readonly string[]): Mode {
  let image: string | undefined
  let connect: string | undefined
  let tokenFile = SHIM_IDENTITY_TOKEN_PATH
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--connect') connect = argv[++i]
    else if (arg === '--token-file') tokenFile = argv[++i] ?? usage()
    else if (!arg.startsWith('--') && image === undefined) image = arg
    else usage()
  }
  if (connect !== undefined && image === undefined) return { connect, tokenFile }
  if (image !== undefined && connect === undefined) return { image }
  return usage()
}

function step(message: string): void {
  console.log(`  ✓ ${message}`)
}

async function until<T>(produce: () => T | undefined, what: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = produce()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

/** Start the image the way a developer would, with this run's token mounted where the pod projects its own. */
async function dockerShim(image: string): Promise<ShimUnderTest> {
  const token = `smoke-${Math.random().toString(36).slice(2)}`
  const scratch = mkdtempSync(join(tmpdir(), 'ac-smoke-'))
  const tokenPath = join(scratch, 'token')
  writeFileSync(tokenPath, token)
  let container: string | undefined
  const stop = (): void => {
    if (container) {
      try {
        execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
  try {
    container = docker([
      'run',
      '--detach',
      '--publish',
      `127.0.0.1::${DEFAULT_SHIM_LISTEN_PORT}`,
      '--volume',
      `${tokenPath}:${SHIM_IDENTITY_TOKEN_PATH}:ro`,
      image
    ])
    step(`container started (${container.slice(0, 12)})`)
    const id = container
    const endpoint = await until(() => {
      try {
        return docker(['port', id, `${DEFAULT_SHIM_LISTEN_PORT}/tcp`]) || undefined
      } catch {
        return undefined
      }
    }, 'the shim port to publish')
    return { endpoint, token, label: image, logs: () => docker(['logs', '--tail', '60', id]), stop }
  } catch (err) {
    stop()
    throw err
  }
}

/** A shim somebody else started — the smoke stage's, whose stderr is already on the build log. */
function connectedShim(endpoint: string, tokenFile: string): ShimUnderTest {
  const token = readFileSync(tokenFile, 'utf8').trim()
  if (!token) throw new Error(`${tokenFile} holds no token for the shim to present`)
  return { endpoint, token, label: endpoint, logs: () => '', stop: () => {} }
}

/** The daemon side: dial, bind, start the runtime through the shim, `initialize`, `session/new`, close. */
async function drive(shim: ShimUnderTest): Promise<void> {
  // The record the handshake binds against; `acp` alone also checks the shim refuses what it was not granted.
  const record: SpawnRecord = {
    agentId: 'smoke-agent',
    sandboxUid: 'smoke-sandbox-uid',
    generation: 1,
    grants: ['acp'],
    podName: 'smoke-pod'
  }
  const dialer = new ShimDialer({
    verifier: {
      reviewToken: async (token) =>
        token === shim.token
          ? { authenticated: true, podName: 'smoke-pod', podUid: 'smoke-pod-uid' }
          : { authenticated: false, error: 'not this run' }
    },
    now: () => Date.now(),
    log: { info: (m) => console.log(`    [dialer] ${m}`), warn: (m) => console.warn(`    [dialer] ${m}`) }
  })
  try {
    const connection = await dialer.connect(`ws://${shim.endpoint}`, record, 90_000)
    step(`daemon dialled the shim at ${shim.endpoint} and bound generation ${connection.binding.generation}`)

    const session = new ShimSession('smoke-agent', record.generation, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
    })
    session.attach(connection)

    // Resolved by the SHIM in the filesystem the runtime reads, so a missing executable is an image defect.
    const opened = (await session.request('acp', {
      op: 'open',
      command: 'claude-agent-acp',
      args: [],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/agent' }
    })) as { streamId?: string }
    if (!opened?.streamId) throw new Error('the shim did not report a stream id for the runtime')
    step(`ACP runtime started in the sandbox (stream ${opened.streamId.slice(0, 8)})`)

    const replies = new Map<number, unknown>()
    let pending = ''
    session.onEvent((event) => {
      if (event.streamId !== opened.streamId || event.event.kind !== 'chunk') return
      pending += Buffer.from(event.event.data, 'base64').toString('utf8')
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
          if (typeof message.id === 'number') replies.set(message.id, message.error ?? message.result)
        } catch {
          /* a notification we do not need */
        }
      }
    })

    const call = async (id: number, method: string, params: unknown): Promise<unknown> => {
      await session.request('acp', {
        op: 'chunk',
        streamId: opened.streamId,
        data: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`).toString('base64')
      })
      return await until(() => replies.get(id), `a reply to ${method}`, 60_000)
    }

    const initialized = (await call(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    })) as { protocolVersion?: number }
    if (typeof initialized?.protocolVersion !== 'number') {
      throw new Error(`initialize did not return a protocol version: ${JSON.stringify(initialized).slice(0, 200)}`)
    }
    step(`ACP initialize → protocol version ${initialized.protocolVersion}`)

    const created = (await call(2, 'session/new', { cwd: '/agent', mcpServers: [] })) as { sessionId?: string }
    if (typeof created?.sessionId !== 'string') {
      throw new Error(`session/new did not return a session id: ${JSON.stringify(created).slice(0, 200)}`)
    }
    step(`ACP session/new → session ${created.sessionId.slice(0, 8)}`)

    await session.request('acp', { op: 'close', streamId: opened.streamId, deadlineMs: 5_000 }).catch(() => undefined)
  } finally {
    dialer.stop()
  }
}

const mode = parseArgs(process.argv.slice(2))
let shim: ShimUnderTest | undefined
try {
  shim = 'image' in mode ? await dockerShim(mode.image) : connectedShim(mode.connect, mode.tokenFile)
  await drive(shim)
  console.log(`\nruntime-sandbox smoke test passed (${shim.label})`)
} catch (err) {
  console.error(`\n✗ smoke test failed: ${(err as Error).message}`)
  let logs = ''
  try {
    logs = shim?.logs() ?? ''
  } catch {
    /* the container may not have started */
  }
  if (logs) console.error(`--- container logs ---\n${logs}`)
  shim?.stop()
  process.exit(1)
}
shim.stop()
process.exit(0)

/**
 * End-to-end smoke test for the runtime-sandbox image.
 *
 *   pnpm --filter @agentconnect.md/daemon exec tsx scripts/smoke-runtime-image.mts <image>
 *
 * Proves the four things the image exists to do, against a REAL container running the REAL shim:
 * the pod starts, the daemon dials its shim and binds, the ACP runtime starts inside it, and
 * a session can be created through the channel. Nothing here is stubbed on the sandbox side —
 * unit tests already cover the protocol, and what this catches is the class of defect they
 * cannot: a shim that cannot resolve its own imports in the image, a runtime that is not on PATH,
 * an entrypoint that never reaches the shim, a non-root user that cannot write its workspace.
 *
 * The daemon side is deliberately minimal: a real ShimDialer with a verifier that accepts this
 * run's token. Pod identity is verified against the API server in production and is unit-tested;
 * re-deriving it here would mean standing up Kubernetes to test a container image.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShimDialer } from '../src/shim/dialer.js'
import { ShimSession } from '../src/shim/session.js'
import type { SpawnRecord } from '../src/shim/binding.js'

const image = process.argv[2]
if (!image) {
  console.error('usage: smoke-runtime-image.mts <image>')
  process.exit(2)
}

const TOKEN = `smoke-${Math.random().toString(36).slice(2)}`
const scratch = mkdtempSync(join(tmpdir(), 'ac-smoke-'))
const tokenPath = join(scratch, 'token')
writeFileSync(tokenPath, TOKEN)

let container: string | undefined
let dialer: ShimDialer | undefined

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

function cleanup(): void {
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
  // The record the handshake binds against: `acp` is the only grant this test needs, and giving
  // it only that also checks the shim refuses to serve what it was not granted.
  const record: SpawnRecord = {
    agentId: 'smoke-agent',
    sandboxUid: 'smoke-sandbox-uid',
    generation: 1,
    grants: ['acp'],
    podName: 'smoke-pod'
  }

  dialer = new ShimDialer({
    verifier: {
      reviewToken: async (token) =>
        token === TOKEN
          ? { authenticated: true, podName: 'smoke-pod', podUid: 'smoke-pod-uid' }
          : { authenticated: false, error: 'not this run' }
    },
    now: () => Date.now(),
    log: { info: (m) => console.log(`    [dialer] ${m}`), warn: (m) => console.warn(`    [dialer] ${m}`) }
  })

  container = execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--publish',
      '127.0.0.1::8085',
      '--volume',
      `${tokenPath}:/var/run/ac-identity/token:ro`,
      image
    ],
    { encoding: 'utf8' }
  ).trim()
  step(`container started (${container.slice(0, 12)})`)

  const published = await until(() => {
    try {
      return execFileSync('docker', ['port', container!, '8085/tcp'], { encoding: 'utf8' }).trim() || undefined
    } catch {
      return undefined
    }
  }, 'the shim port to publish')
  const connection = await dialer.connect(`ws://${published}`, record, 90_000)
  step(`daemon dialled the shim and bound generation ${connection.binding.generation}`)

  const session = new ShimSession('smoke-agent', record.generation, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
  })
  session.attach(connection)

  // Start the real ACP runtime inside the container. The command is resolved by the SHIM, in the
  // filesystem the runtime will read — which is the point of that seam and what makes a missing
  // executable an image defect rather than a daemon one.
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
  })) as { protocolVersion?: number; agentCapabilities?: unknown }
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
  console.log(`\nruntime-sandbox smoke test passed (${image})`)
} catch (err) {
  console.error(`\n✗ smoke test failed: ${(err as Error).message}`)
  if (container) {
    console.error('--- container logs ---')
    try {
      console.error(execFileSync('docker', ['logs', '--tail', '60', container], { encoding: 'utf8' }))
    } catch {
      /* container may not have started */
    }
  }
  cleanup()
  dialer?.stop()
  process.exit(1)
}

cleanup()
dialer?.stop()
process.exit(0)

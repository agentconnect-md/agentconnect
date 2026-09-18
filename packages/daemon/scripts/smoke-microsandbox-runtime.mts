// Real-VM smoke test and measurement for the microsandbox backend; needs Linux with a usable /dev/kvm and a built daemon.
// Usage: pnpm --filter @agentconnect.md/daemon exec tsx scripts/smoke-microsandbox-runtime.mts <image> [transfer-MiB]
// It reads the guest socket paths from the launch environment and calls only what both sides of the move onto the shim have, so the same file measures the previous mechanism from a checkout of it.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SpawnedRuntime } from '../src/acp/spawn-driver.js'
import { makeLogger } from '../src/log.js'
import { installMicrosandbox } from '../src/microsandbox/install.js'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { microsandboxSupportMounts } from '../src/microsandbox/support.js'

const [image, transferArg] = process.argv.slice(2)
if (!image) throw new Error('usage: smoke-microsandbox-runtime.mts <image> [transfer-MiB]')
const transferBytes = Number(transferArg ?? 20) * 1024 * 1024
// Short on purpose: the SDK derives unix socket paths from this root, and they must fit the 108-byte limit.
const root = await mkdtemp(join(tmpdir(), 'acm-'))
const summary: Record<string, number | string> = { image }
const step = (name: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ step: name, ...detail }))
const elapsed = (since: number) => Math.round(performance.now() - since)

/** A stand-in for one of the daemon's own servers: it names itself in an echo, and sinks or sources bulk bytes. */
async function daemonSocket(path: string, name: string): Promise<Server> {
  const server = createServer((socket: Socket) => {
    let command: string | undefined
    let received = 0
    socket.on('error', () => {})
    socket.on('data', (data: Buffer) => {
      if (command === undefined) {
        const line = data.subarray(0, data.indexOf(10) + 1).toString()
        command = line.trim()
        data = data.subarray(line.length)
        if (command.startsWith('pull ')) {
          const chunk = Buffer.alloc(64 * 1024, 120)
          let left = Number(command.slice(5))
          const pump = (): void => {
            while (left > 0) {
              const slice = chunk.subarray(0, Math.min(chunk.length, left))
              left -= slice.length
              if (!socket.write(slice)) return void socket.once('drain', pump)
            }
            socket.end()
          }
          pump()
          return
        }
        if (command.startsWith('echo ')) return void socket.end(`${name}:${command.slice(5)}\n`)
      }
      received += data.length
      if (command?.startsWith('push ') && received >= Number(command.slice(5))) socket.end(`${received}\n`)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return server
}

/** The in-VM half: one connection to a guest socket, run as the runtime user by the guest's own Node. */
const GUEST_CLIENT = `
const [path, command, bytes] = process.argv.slice(1);
const socket = require('node:net').connect(path);
const started = process.hrtime.bigint();
let received = 0, reply = '';
socket.on('connect', () => {
  socket.write(command + (bytes ? ' ' + bytes : '') + '\\n');
  if (command !== 'push') return;
  const chunk = Buffer.alloc(64 * 1024, 120);
  let left = Number(bytes);
  const pump = () => {
    while (left > 0) {
      const slice = chunk.subarray(0, Math.min(chunk.length, left));
      left -= slice.length;
      if (!socket.write(slice)) return void socket.once('drain', pump);
    }
  };
  pump();
});
socket.on('data', (data) => { received += data.length; if (command !== 'pull') reply += data; });
socket.on('close', () => {
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write(JSON.stringify({ reply: reply.trim(), received, ms }));
});
socket.on('error', (error) => { process.stderr.write(String(error)); process.exit(1); });
`

/** Reports where, as whom and with what environment a runtime started by the driver runs, then waits for stdin to close. */
const IDENTITY_RUNTIME = `#!/usr/local/bin/node
process.stdout.write(JSON.stringify({
  uid: process.getuid(), cwd: process.cwd(), home: process.env.HOME, path: process.env.PATH,
  imageEnv: process.env.NODE_OPTIONS ?? null, key: process.env.OPENAI_API_KEY ?? null,
  authRequest: process.env.DEFAULT_AUTH_REQUEST ?? null
}) + '\\n');
process.stdin.resume();
`

/** The first JSON line a runtime writes; anything else on its stdout is skipped. */
async function firstJsonLine(runtime: SpawnedRuntime): Promise<Record<string, unknown>> {
  const reader = runtime.fromAgent.getReader()
  let text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the runtime ended before answering: ${text}`)
      text += Buffer.from(value).toString()
      const lines = text.split('\n')
      text = lines.pop() ?? ''
      for (const line of lines) {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          /* not the reply */
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

const sockets = { mcp: join(root, 'mcp.sock'), gitcred: join(root, 'gitcred.sock') }
const servers = [await daemonSocket(sockets.mcp, 'mcp'), await daemonSocket(sockets.gitcred, 'gitcred')]
let generation = 0
const manager = await installMicrosandbox({
  root,
  config: { image, cpus: 2, memoryMiB: 2048, diskGiB: 8 },
  sockets,
  log: makeLogger('info'),
  nextShimGeneration: async () => ++generation
})
let passed = false
const environmentId = 'smoke/session-000000000000000000000000'
try {
  const since = performance.now()
  await manager.prepare()
  summary.prepareMs = elapsed(since)
  step('image-and-vm-startup-verified', { ms: summary.prepareMs })

  const scopeDir = join(root, 'agent')
  const cwd = join(scopeDir, 'workspace')
  const hostHome = join(root, 'host-home')
  await mkdir(cwd, { recursive: true })
  await mkdir(hostHome)
  const launch = prepareMicrosandboxLaunch({
    runtimeId: 'smoke',
    scopeDir,
    cwd,
    daemonRoot: root,
    stateSourceEnv: { HOME: hostHome, PATH: process.env.PATH },
    mounts: [],
    trustedMounts: microsandboxSupportMounts(root)
  })
  const environment = { id: environmentId, ...launch.microsandbox }
  const guestSockets = dirname(launch.env.AC_GITCRED_SOCKET!)
  const driver = manager.driverFor(environment)
  const initialize = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } }
  })}\n`

  /** Start the image's ACP runtime and time the launch up to its `initialize` reply. */
  const acpRoundTrip = async (): Promise<number> => {
    const started = performance.now()
    const runtime = await driver.launch({ command: 'claude-agent-acp', args: [], env: launch.env })
    const writer = runtime.toAgent.getWriter()
    await writer.write(Buffer.from(initialize))
    writer.releaseLock()
    const reply = (await firstJsonLine(runtime)) as { id?: number; result?: { protocolVersion?: number } }
    const ms = elapsed(started)
    assert.equal(reply.id, 1)
    assert.equal(typeof reply.result?.protocolVersion, 'number', `initialize failed: ${JSON.stringify(reply)}`)
    const exited = new Promise<void>((resolve) => runtime.onExit(resolve))
    await runtime.stop(10_000)
    await exited
    return ms
  }

  summary.coldLaunchToInitializeMs = await acpRoundTrip()
  step('acp-initialize-answered-on-a-cold-vm', { ms: summary.coldLaunchToInitializeMs })
  summary.warmLaunchToInitializeMs = await acpRoundTrip()
  step('acp-initialize-answered-on-the-running-vm', { ms: summary.warmLaunchToInitializeMs })

  // Named like Codex on purpose: a pod's shim would turn an inherited key into that runtime's login, and a VM's must not.
  const probe = join(cwd, 'codex-smoke')
  await writeFile(probe, IDENTITY_RUNTIME, { mode: 0o755 })
  const identity = await driver.launch({
    command: probe,
    args: [],
    env: { ...launch.env, OPENAI_API_KEY: 'inherited-from-the-host' }
  })
  const who = await firstJsonLine(identity)
  await identity.stop(10_000)
  assert.equal(who.uid, 10001, 'the runtime must run as the image user')
  assert.equal(who.cwd, environment.workspaceRoot)
  assert.equal(who.home, launch.env.HOME)
  // A direct guest exec puts the guest agent's own script directory in front; the shim starts the runtime with the PATH it was sent.
  assert.ok(String(who.path).endsWith(launch.env.PATH!), `unexpected PATH: ${String(who.path)}`)
  assert.equal(who.imageEnv, '--dns-result-order=ipv4first', 'the image environment must reach the runtime')
  assert.equal(who.key, 'inherited-from-the-host')
  assert.equal(who.authRequest, null, 'the launch environment must arrive as the daemon sent it')
  step('runtime-identity-directory-and-environment-verified', who)

  const guest = async (tunnel: keyof typeof sockets, command: string, bytes?: number) => {
    const result = await manager.exec(
      environment,
      '/usr/local/bin/node',
      ['-e', GUEST_CLIENT, join(guestSockets, `${tunnel}.sock`), command, ...(bytes ? [String(bytes)] : [])],
      { cwd: environment.workspaceRoot, env: launch.env, timeoutMs: 60_000 }
    )
    assert.equal(result.exitCode, 0, `${tunnel} ${command}: ${result.stderr}`)
    return JSON.parse(result.stdout) as { reply: string; received: number; ms: number }
  }
  for (const tunnel of ['mcp', 'gitcred'] as const) {
    assert.equal((await guest(tunnel, 'echo hello')).reply, `${tunnel}:hello`)
  }
  step('both-helper-endpoints-reach-their-own-daemon-socket', { guestSockets })

  await manager.suspend(environment.id)
  summary.resumedLaunchToInitializeMs = await acpRoundTrip()
  step('acp-initialize-answered-after-resuming-the-stopped-vm', { ms: summary.resumedLaunchToInitializeMs })
  for (const tunnel of ['mcp', 'gitcred'] as const) {
    assert.equal((await guest(tunnel, 'echo resumed')).reply, `${tunnel}:resumed`)
  }
  step('both-helper-endpoints-served-again-on-the-resumed-vm')

  // Ascending sizes per direction, so a path that stalls on a large transfer still reports what it carried before that.
  let stalled: string | undefined
  for (const [command, label] of [
    ['push', 'guestToDaemon'],
    ['pull', 'daemonToGuest']
  ] as const) {
    for (const mib of [...new Set([1, 8, transferBytes / (1024 * 1024)])]) {
      const bytes = mib * 1024 * 1024
      try {
        const moved = await guest('mcp', command, bytes)
        assert.equal(command === 'push' ? Number(moved.reply) : moved.received, bytes)
        summary[`${label}MiBps@${mib}MiB`] = Number((mib / (moved.ms / 1000)).toFixed(1))
      } catch (error) {
        stalled ??= `${label} ${mib} MiB: ${(error as Error).message}`
        summary[`${label}MiBps@${mib}MiB`] = 'failed'
        break
      }
    }
  }
  step('bulk-transfer-through-the-mcp-endpoint', summary)
  if (stalled) {
    console.log(JSON.stringify({ summary }))
    throw new Error(`bulk transfer through the mcp endpoint did not complete (${stalled})`)
  }

  passed = true
} finally {
  await manager.discard(environmentId).catch((error: unknown) => console.error(error))
  await manager.stopAll().catch((error: unknown) => console.error(error))
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Inspection files retained at ${root}`)
}
console.log(JSON.stringify({ summary }))
process.exit(0)

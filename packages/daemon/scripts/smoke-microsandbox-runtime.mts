// Real-VM smoke test and measurement for the microsandbox backend and the executor facet's VM strategy; needs Linux with a usable /dev/kvm and a built daemon.
// Usage: pnpm --filter @agentconnect.md/daemon exec tsx scripts/smoke-microsandbox-runtime.mts <image> [transfer-MiB]
// It reads the guest socket paths from the launch environment and calls only what both sides of the move onto the shim have, so the same file measures the previous mechanism from a checkout of it.
import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sessionHostKey, sessionKeyDirName } from '../src/acp/host-key.js'
import type { SpawnedRuntime } from '../src/acp/spawn-driver.js'
import { seedSessionHome, startExecutorFacet } from '../src/execution/executor-facet.js'
import { ExecutorPlane } from '../src/execution/executor-plane.js'
import { microsandboxLauncher } from '../src/execution/executor-vm.js'
import type { PlaneLaunch } from '../src/execution/plane.js'
import { assembleRuntimeLaunch } from '../src/launch/assemble.js'
import { makeLogger } from '../src/log.js'
import { installMicrosandbox } from '../src/microsandbox/install.js'
import { prepareMicrosandboxLaunch } from '../src/microsandbox/launch.js'
import { microsandboxSupportMounts } from '../src/microsandbox/support.js'
import { sessionSandboxSubject } from '../src/remote/sandbox-subject.js'
import { DEFAULT_SHIM_RUNTIME_ROOT } from '../src/shim/sandbox-paths.js'

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
// The executor facet's half: one session this machine hosts for a group member, over the `microsandbox` strategy.
const AGENT = '11111111-1111-4111-8111-111111111111'
const EXECUTOR = '22222222-2222-4222-8222-222222222222'
const SESSION_KEY = `webchat:smoke:1700000000.000100:${AGENT}`
const LEAF = sessionKeyDirName(SESSION_KEY)
const SUBJECT = sessionSandboxSubject(AGENT, LEAF)
const HOST_KEY = sessionHostKey(AGENT, SESSION_KEY)
const hostedDir = join(root, 'sessions', LEAF)
const hostedReport = join(hostedDir, 'workspace', 'from-the-guest')
/** Reports its environment and whether the sign-in it is pointed at is there, into the mounted workspace, then echoes. */
const HOSTED_RUNTIME = [
  "const fs = require('fs')",
  'const signIn = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR',
  "const signedIn = Boolean(signIn) && fs.existsSync(signIn + '/.credentials.json')",
  'fs.writeFileSync(process.env.AC_TEST_REPORT, JSON.stringify({ env: process.env, signedIn }))',
  'process.stdin.pipe(process.stdout)'
].join('; ')
// This machine's own Claude sign-in, which the facet seeds the session HOME from; the VM must be given it (§8).
const machineHome = join(root, 'machine')
await mkdir(join(machineHome, '.claude'), { recursive: true, mode: 0o700 })
await writeFile(join(machineHome, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}\n', { mode: 0o600 })
const facet = await startExecutorFacet({
  daemonRoot: root,
  share: true,
  // The one strategy under test here; `host` has its own end-to-end case and needs no VM.
  strategies: () => ({
    host: { available: false, reason: 'not part of this smoke test' },
    microsandbox: { available: true }
  }),
  launchers: { microsandbox: microsandboxLauncher({ manager: () => manager }) },
  capacity: () => 2,
  ownSessions: () => 0,
  draining: () => false,
  endpointHost: () => '127.0.0.1',
  seedHome: (home) =>
    seedSessionHome(home, { 'claude-acp': { command: 'claude-agent-acp', args: [], env: [] } }, console, {
      HOME: machineHome
    }),
  agentsExist: async (ids: string[]) => new Set(ids),
  retentionMs: () => null,
  log: makeLogger('info'),
  listen: { host: '127.0.0.1' }
})
/** The holder, unmodified: its own plane, dialing the facet's pipe. The Control Plane's relay is the call below. */
const plane = new ExecutorPlane({
  prepare: (launch) =>
    facet.prepare({
      agentId: launch.agentId,
      sessionKey: launch.sessionKey,
      executorDaemonId: launch.executorDaemonId,
      launchId: launch.launchId,
      strategy: launch.strategy
    }),
  release: (placed, launchId) =>
    facet.release({
      agentId: placed.agentId,
      sessionKey: placed.sessionKey,
      executorDaemonId: placed.executorDaemonId,
      launchId
    }),
  replace: async () => undefined,
  log: { info: () => {}, warn: (m: string) => console.error(m) }
})

/** Birth or a new launch: prepare on the executor and bind its shim through the pipe. */
async function hostedLaunch(): Promise<number> {
  const landed = await plane.prepareAt(AGENT, SESSION_KEY, [{ daemonId: EXECUTOR, strategy: 'microsandbox' }])
  assert.ok('placed' in landed, `nothing was prepared: ${JSON.stringify(landed)}`)
  await plane.ensureChannel(SUBJECT)
  return plane.shimGenerationFor(SUBJECT)!
}

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

  // The local environment's VM is stopped first, so only the hosted one is running for the rest.
  await manager.suspend(environmentId)

  const hosted = performance.now()
  const firstGeneration = await hostedLaunch()
  summary.hostedLaunchMs = elapsed(hosted)
  assert.equal(firstGeneration, 1)
  // The shim reports the executor-local mount, which is what the holder composes this session's paths on (§7).
  assert.equal(plane.mountFor(SUBJECT), root)
  // Inside a VM the shim owns its filesystem namespace, so the reply names the image's roots and no per-session one (§5).
  assert.deepEqual(plane.rootsFor(SESSION_KEY), { runtimeRoot: DEFAULT_SHIM_RUNTIME_ROOT, missingHelpers: [] })
  step('hosted-vm-prepared-and-its-shim-bound-through-the-pipe', { ms: summary.hostedLaunchMs })

  // A REAL prepared launch, composed as the holder composes a placed session's: on the HOME its executor seeded (§7).
  const home = plane.homeFor(SUBJECT)!
  assert.equal(home, join(hostedDir, 'home'))
  const holderAgentDir = join(root, 'holder-agent')
  await mkdir(holderAgentDir)
  const holderEnv = { HOME: holderAgentDir, PATH: '/holder/bin', HOLDER_ONLY: 'holder' }
  const prepared = assembleRuntimeLaunch({
    runtimeId: 'claude-acp',
    runtime: { command: '/usr/local/bin/node', args: ['-e', HOSTED_RUNTIME], env: [] },
    provider: 'managed',
    scopeDir: holderAgentDir,
    cwd: join(hostedDir, 'workspace'),
    hostKey: HOST_KEY,
    runInSandbox: false,
    runtimeEnv: {},
    agentEnv: { AC_AGENT_ID: AGENT, AC_TEST_REPORT: hostedReport },
    hostEnv: holderEnv,
    stateSourceEnv: holderEnv,
    executor: { home }
  })
  // What AcpHost hands the driver; only the host key of a launch is read, the rest belongs to an agent this script does not load.
  const hostedDriver = plane.spawnFor({ hostKey: HOST_KEY } as unknown as PlaneLaunch).driver
  const echo = await hostedDriver.launch({
    command: prepared.runtime.command,
    args: prepared.runtime.args,
    env: { ...(prepared.launch.inheritProcessEnv ? holderEnv : {}), ...prepared.launch.env },
    hostKey: HOST_KEY
  })
  const writer = echo.toAgent.getWriter()
  await writer.write(Buffer.from(`${JSON.stringify({ hello: 'executor' })}\n`))
  writer.releaseLock()
  assert.deepEqual(await firstJsonLine(echo), { hello: 'executor' })
  await echo.stop(10_000)

  // Read back from THIS machine's disk: the guest wrote it into the mount, never onto the VM's own disks (§7).
  const inGuest = JSON.parse(await readFile(hostedReport, 'utf8')) as {
    env: Record<string, string | undefined>
    signedIn: boolean
  }
  const seen = inGuest.env
  assert.equal(seen.AC_AGENT_ID, AGENT, 'the launch environment did not reach the runtime')
  assert.equal(seen.HOME, home)
  assert.equal(seen.XDG_CONFIG_HOME, join(home, '.config'))
  assert.equal(seen.CLAUDE_CONFIG_DIR, join(home, '.claude'))
  // The executor's own sign-in: its shim fills the pointer in, and the VM was given the directory it names (§8).
  assert.equal(seen.CLAUDE_SECURESTORAGE_CONFIG_DIR, realpathSync(join(machineHome, '.claude')))
  assert.ok(inGuest.signedIn, "the executor's sign-in is not reachable in the guest")
  // Nothing of the holder's environment; the PATH is the guest's own fill-in, which a complete-env shim would not make (§6).
  assert.equal(seen.HOLDER_ONLY, undefined)
  assert.deepEqual(
    Object.entries(seen).filter(([, value]) => value?.includes(holderAgentDir) || value === '/holder/bin'),
    []
  )
  assert.ok(seen.PATH, 'the guest filled in no PATH of its own')
  step('hosted-prepared-launch-echoed-under-the-seeded-home-and-sign-in', {
    home: seen.HOME,
    path: seen.PATH,
    signIn: seen.CLAUDE_SECURESTORAGE_CONFIG_DIR
  })

  // Idle drops the launch, and the next one is a NEW launchId: the executor rotates the key and allocates the next generation.
  await plane.suspendIdle(SUBJECT)
  assert.equal(await hostedLaunch(), firstGeneration + 1)
  // The same environment, so the first launch's work is still in the mount.
  assert.ok(existsSync(hostedReport), 'the relaunch did not reuse the environment')
  step('a-second-launch-rotated-the-key-and-bound-the-same-shim', { generation: firstGeneration + 1 })

  await plane.retire(AGENT, SESSION_KEY)
  assert.ok(!(await manager.environmentIds()).includes(`executor/${LEAF}`), 'the released VM was kept')
  assert.equal(existsSync(hostedDir), false, 'the released session directory was kept')
  step('the-release-took-the-vm-its-disks-and-the-session-directory')

  passed = true
} finally {
  await plane.stop().catch((error: unknown) => console.error(error))
  await facet.stop().catch((error: unknown) => console.error(error))
  await manager.discard(environmentId).catch((error: unknown) => console.error(error))
  await manager.discard(`executor/${LEAF}`).catch((error: unknown) => console.error(error))
  await manager.stopAll().catch((error: unknown) => console.error(error))
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  if (passed) await rm(root, { recursive: true, force: true })
  else console.error(`Inspection files retained at ${root}`)
}
console.log(JSON.stringify({ summary }))
process.exit(0)

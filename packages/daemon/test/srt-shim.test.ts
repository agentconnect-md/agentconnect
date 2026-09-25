import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ClientTransport } from '@agentconnect.md/connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeSandboxHost } from '../src/acp/sandbox.js'
import { hostedEnvironment } from '../src/execution/executor-vm.js'
import { startHostShim, sweepStaleHostShims, type HostShim } from '../src/execution/host-shim.js'
import { srtShimBoundary, srtShimPolicy } from '../src/execution/srt-shim.js'
import { srtLauncher, type SessionEnvironment } from '../src/execution/strategies.js'
import { ShimDialer } from '../src/shim/dialer.js'
import { ShimGitRunner } from '../src/shim/git-exec.js'
import { ShimSession } from '../src/shim/session.js'
import { WAIT } from './wait-support.js'

const silent = { info: () => {}, warn: () => {} }
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
const LEAF = 'session-0123456789abcdef01234567'
const OTHER = 'session-76543210fedcba9876543210'
// The real boundary needs Linux with bwrap, socat and rg; elsewhere only the policy cases run.
const srt = process.platform === 'linux' && probeSandboxHost().mechanism === 'bwrap'
// The source entry under tsx, by absolute URL: the shim's cwd is the session's, where a bare `tsx` does not resolve.
const entry = {
  execArgv: [
    '--conditions',
    'development',
    '--import',
    pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href
  ],
  path: fileURLToPath(new URL('../src/shim/index.ts', import.meta.url))
}
// What a source shim reads: this checkout (the entry, tsx and the workspace packages) and node, wherever they are installed.
const REPO = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)))
const READ_ROOTS = [REPO, dirname(dirname(realpathSync(process.execPath)))]
const LAUNCHER = fileURLToPath(new URL('./fixtures/srt-shim-launcher.ts', import.meta.url))

/** Host pids carrying a shim's mark: pid namespaces renumber what runs inside, so the host finds them the way the sweep does. */
async function markedPids(mark: string): Promise<number[]> {
  const wanted = `AC_SHIM_RUNTIME_MARK=${mark}`
  const pids: number[] = []
  for (const name of await readdir('/proc')) {
    const pid = Number(name)
    if (!Number.isInteger(pid)) continue
    const environ = await readFile(`/proc/${pid}/environ`, 'latin1').catch(() => '')
    // A zombie runs nothing and is no survivor.
    const state = await readFile(`/proc/${pid}/stat`, 'latin1').catch(() => '')
    if (environ.split('\0').includes(wanted) && state.split(') ')[1]?.[0] !== 'Z') pids.push(pid)
  }
  return pids
}

/** The holder's side: a real dialer over the shim's unix socket, from outside the boundary's network namespace; no token accepts any, as a hosted dial does. */
async function bind(connectShim: () => ReturnType<typeof connect>, token: string | undefined, subject: string) {
  const session = new ShimSession(subject, 1, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
  const dialer = new ShimDialer({
    verifier: {
      reviewToken: async (presented) =>
        token === undefined || presented === token
          ? { authenticated: true, podName: subject, podUid: subject }
          : { authenticated: false, error: 'not this shim' }
    },
    dial: (url, options) => ClientTransport.dial(url, { ...options, createConnection: connectShim }) as never,
    onConnection: (connection) => session.attach(connection),
    log: silent
  })
  await dialer.connect(
    'ws://localhost',
    { agentId: 'agent-1', subject, sandboxUid: subject, generation: 1, grants: ['acp', 'exec'], podName: subject },
    30_000
  )
  return { session, dialer }
}

/** Run one script as a runtime through the shim and return the one JSON line it writes. */
async function runThrough(session: ShimSession, cwd: string, script: string): Promise<Record<string, any>> {
  const opened = (await session.request('acp', {
    op: 'open',
    command: process.execPath,
    args: ['-e', script],
    env: { PATH: process.env.PATH ?? '' },
    cwd
  })) as { streamId: string }
  let out = ''
  session.onEvent((event) => {
    if (event.streamId === opened.streamId && event.event.kind === 'chunk')
      out += Buffer.from(event.event.data, 'base64').toString()
  })
  await vi.waitFor(() => expect(out).toContain('\n'), { ...WAIT, timeout: 60_000 })
  return JSON.parse(out.slice(0, out.indexOf('\n'))) as Record<string, any>
}

// What a runtime can reach from inside: files outside its session, and SRT's proxy env.
const PROBE = (root: string) => `
const fs = require('fs'), cp = require('child_process')
const attempt = (fn) => { try { return { ok: true, value: fn() } } catch (e) { return { ok: false, code: e.code } } }
const out = {
  secret: attempt(() => fs.readFileSync(${JSON.stringify(join(root, 'secret'))}, 'utf8')),
  otherSession: attempt(() => fs.readdirSync(${JSON.stringify(join(root, 'sessions', OTHER))})),
  planted: attempt(() => fs.writeFileSync(${JSON.stringify(join(root, 'planted'))}, 'x')),
  git: cp.spawnSync('git', ['init', '-q', 'repo'], { encoding: 'utf8' }).status,
  env: { HTTPS_PROXY: process.env.HTTPS_PROXY, NO_PROXY: process.env.NO_PROXY, NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY, HOME: process.env.HOME }
}
process.stdout.write(JSON.stringify(out) + '\\n')
`

describe('the srt boundary around a shim', () => {
  let root: string | undefined
  const shims: HostShim[] = []
  const environments: SessionEnvironment[] = []
  const dialers: ShimDialer[] = []
  const launchers: ChildProcess[] = []

  afterEach(async () => {
    for (const dialer of dialers.splice(0)) dialer.stop()
    for (const shim of shims.splice(0)) await shim.stop()
    for (const environment of environments.splice(0)) await environment.stop()
    for (const launcher of launchers.splice(0)) launcher.kill('SIGKILL')
    if (root) await sweepStaleHostShims(root)
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  // session-executors.md §5: no `.git` deny (the holder's Git runs inside), and every exception is held to the protected roots.
  it.skipIf(process.platform !== 'linux')(
    "writes the session, its HOME, the runtime root and SRT's temp root, and hides the daemon root and HOME",
    () => {
      const layout = {
        runtimeRoot: '/srv/ac/hs/abc',
        workspaceRoot: '/srv/ac/sessions/s',
        home: '/srv/ac/sessions/s/home',
        helperRoot: '/opt/ac/dist'
      }
      const hostEnv = { HOME: '/home/op', PATH: '/usr/bin' }
      const { policy, skipped } = srtShimPolicy({
        daemonRoot: '/srv/ac',
        agentsRoot: '/srv/agents',
        layout,
        tempDir: '/srv/ac/hs/abc/t',
        mounts: [
          { source: '/srv/ac/sessions/s', target: '/srv/ac/sessions/s', mode: 'writable' },
          { source: '/home/op/.claude', target: '/home/op/.claude', mode: 'writable' },
          { source: '/srv/data', target: '/srv/data', mode: 'readonly' }
        ],
        readRoots: ['/srv/ac/runtimes', '/home/op/.local/share/runtime', '/home'],
        hostEnv
      })
      expect(policy.writable).toEqual([
        '/srv/ac/sessions/s',
        '/srv/ac/sessions/s/home',
        '/srv/ac/hs/abc',
        '/srv/ac/hs/abc/t',
        '/home/op/.claude'
      ])
      expect(policy.denyRead).toEqual(expect.arrayContaining(['/srv/ac', '/srv/agents', '/home/op', '/tmp', '/run']))
      expect(policy.allowRead).toEqual(
        expect.arrayContaining(['/srv/ac/sessions/s', '/opt/ac/dist', '/srv/ac/runtimes', '/srv/data'])
      )
      // A read root that would reopen HOME is left out and named, never granted.
      expect(skipped).toEqual(['/home'])
      expect(policy.allowRead).not.toContain('/home')
      expect(policy.denyWrite).toBeUndefined()
      expect(policy.gitSafeDirectories).toEqual(['/srv/ac/sessions/s'])
      // A writable mount that would reopen a protected root refuses the environment.
      expect(() =>
        srtShimPolicy({
          daemonRoot: '/srv/ac',
          layout,
          tempDir: '/srv/ac/hs/abc/t',
          mounts: [{ source: '/home', target: '/home', mode: 'writable' }],
          readRoots: [],
          hostEnv
        })
      ).toThrow(/would reopen protected path/)
    }
  )

  it.skipIf(!srt)(
    'runs the shim inside: a dial from outside binds it, the holder’s Git works in its clones, and nothing outside is reachable',
    { timeout: 180_000 },
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-srt-'))
      await writeFile(join(root, 'secret'), 'daemon state')
      await mkdir(join(root, 'sessions', OTHER, 'workspace'), { recursive: true })
      const environment = hostedEnvironment(root, LEAF)
      const shim = await startHostShim({
        daemonRoot: root,
        workspaceRoot: environment.workspaceRoot,
        entry,
        boundary: srtShimBoundary({ daemonRoot: root, mounts: environment.mounts, readRoots: READ_ROOTS })
      })
      shims.push(shim)
      // The policy lives beside the runtime root, outside everything the boundary can write.
      expect(existsSync(`${shim.runtimeRoot}.p`)).toBe(true)
      const { session, dialer } = await bind(() => connect(shim.socketPath), shim.token, 'subject-srt')
      dialers.push(dialer)
      const workspace = join(environment.workspaceRoot, 'workspace')
      const seen = await runThrough(session, workspace, PROBE(root))

      expect(seen.env.HOME).toBe(join(environment.workspaceRoot, 'home'))
      // SRT's proxy bridge is the runtime's only route out, and it arrives.
      expect(seen.env.HTTPS_PROXY).toMatch(/^http:\/\/.*localhost:\d+$/)
      expect(seen.env.NO_PROXY).toContain('localhost')
      expect(seen.env.NODE_USE_ENV_PROXY).toBe('1')
      // The daemon root and another session stay hidden, and nothing is written outside the session.
      expect(seen.secret.ok).toBe(false)
      expect(seen.otherSession.ok).toBe(false)
      // A hidden root is an empty tmpfs inside, so a write there lands nowhere this machine sees.
      expect(existsSync(join(root, 'planted'))).toBe(false)

      // The holder's Git runs through the shim inside the boundary, so it writes `.git/config` as in a VM.
      expect(seen.git).toBe(0)
      const git = new ShimGitRunner(session, join(workspace, 'repo'))
      await git.raw(['config', 'user.name', 'Example Holder'])
      await git.raw(['remote', 'add', 'origin', 'https://example.test/example-org/example-repo.git'])
      expect((await git.raw(['config', '--get', 'remote.origin.url'])).trim()).toBe(
        'https://example.test/example-org/example-repo.git'
      )
      // A holder's empty proxy pin names SRT's bridge where its Git runs, with Basic proxy auth beside it.
      const pinned = new ShimGitRunner(session, join(workspace, 'repo'), {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://example.test/example-org/example-repo.git.proxy',
        GIT_CONFIG_VALUE_0: ''
      })
      expect(
        (await pinned.raw(['config', '--get', 'http.https://example.test/example-org/example-repo.git.proxy'])).trim()
      ).toBe(seen.env.HTTPS_PROXY)
      expect((await pinned.raw(['config', '--get', 'http.proxyAuthMethod'])).trim()).toBe('basic')

      // A runtime that needs to finish on SIGTERM, which the shim sends when it drains.
      const drained = join(workspace, 'drained')
      const trapping = `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(drained)}, 'yes'); process.exit(0) })
setInterval(() => {}, 60000)
process.stdout.write(JSON.stringify({ up: true }) + '\\n')`
      expect(await runThrough(session, workspace, trapping)).toEqual({ up: true })

      // Stopping closes the shim's stdin: it drains its runtimes before the boundary goes, then its roots go and the workspace stays.
      const mark = (await readFile(join(shim.runtimeRoot, 'mark'), 'utf8')).trim()
      expect((await markedPids(mark)).length).toBeGreaterThan(0)
      await shim.stop()
      shims.splice(0)
      expect(existsSync(drained)).toBe(true)
      expect(await markedPids(mark)).toEqual([])
      expect(existsSync(shim.runtimeRoot) || existsSync(`${shim.runtimeRoot}.p`)).toBe(false)
      expect(existsSync(join(workspace, 'repo', '.git', 'config'))).toBe(true)
    }
  )

  it.skipIf(!srt)(
    'ends the sandbox — shim, runtime and all — once the process that started it is killed',
    { timeout: 180_000 },
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-srt-'))
      const launcher = spawn(
        process.execPath,
        [...entry.execArgv, LAUNCHER, root, LEAF, JSON.stringify(entry), JSON.stringify(READ_ROOTS)],
        { stdio: ['ignore', 'pipe', 'inherit'] }
      )
      launchers.push(launcher)
      const where = await new Promise<{ socketPath: string; token: string; runtimeRoot: string }>((resolve, reject) => {
        let out = ''
        launcher.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          if (out.includes('\n')) resolve(JSON.parse(out))
        })
        launcher.once('exit', () => reject(new Error('the launcher exited before it reported its shim')))
      })
      const mark = (await readFile(join(where.runtimeRoot, 'mark'), 'utf8')).trim()
      const { session, dialer } = await bind(() => connect(where.socketPath), where.token, 'subject-orphan')
      dialers.push(dialer)
      const idle = `process.stdout.write(JSON.stringify({ up: true }) + '\\n'); setInterval(() => {}, 60000)`
      expect(await runThrough(session, join(root, 'sessions', LEAF, 'workspace'), idle)).toEqual({ up: true })
      // The shim and its runtime, each carrying the mark.
      expect((await markedPids(mark)).length).toBeGreaterThanOrEqual(2)

      // No stop and no descriptor to close: the provider's owner watch is all that notices.
      launcher.kill('SIGKILL')
      await vi.waitFor(async () => expect(await markedPids(mark)).toEqual([]), WAIT)
    }
  )

  it.skipIf(!srt)(
    'runs through the srt launcher with the hosted descriptor, its HOME seed pointing on this machine',
    {
      timeout: 180_000
    },
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-srt-'))
      const signIn = join(root, 'sign-in')
      await mkdir(signIn)
      await writeFile(join(signIn, 'credentials'), 'refreshable')
      const launcher = srtLauncher(root, { readRoots: () => READ_ROOTS }, (input) => startHostShim({ ...input, entry }))
      const started = await launcher.start({
        environment: hostedEnvironment(root, LEAF, { env: { EXAMPLE_SIGN_IN: signIn }, paths: [signIn] }),
        log: quiet
      })
      environments.push(started)
      expect(started.helperRoot).toBe(dirname(dirname(entry.path)))
      // The hosted token is never compared (the pipe proves the peer), so any presented identity binds here.
      const { session, dialer } = await bind(
        () => started.connect() as ReturnType<typeof connect>,
        undefined,
        'subject-hosted'
      )
      dialers.push(dialer)
      const script = `
const fs = require('fs')
const p = process.env.EXAMPLE_SIGN_IN + '/credentials'
fs.appendFileSync(p, ' refreshed')
process.stdout.write(JSON.stringify({ seen: fs.readFileSync(p, 'utf8') }) + '\\n')`
      // The seed's pointer reaches the runtime, and the sign-in it names is writable for a refresh (§8).
      expect(await runThrough(session, join(root, 'sessions', LEAF, 'workspace'), script)).toEqual({
        seen: 'refreshable refreshed'
      })
    }
  )
})

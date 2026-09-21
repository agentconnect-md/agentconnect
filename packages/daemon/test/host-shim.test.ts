import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ClientTransport } from '@agentconnect.md/connection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hostShimEnv,
  hostShimUnavailableReason,
  startHostShim,
  sweepStaleHostShims,
  type HostShim
} from '../src/execution/host-shim.js'
import { effectiveStrategies } from '../src/execution/strategies.js'
import { ShimDialer } from '../src/shim/dialer.js'
import { ShimSession } from '../src/shim/session.js'
import { WAIT } from './wait-support.js'

const silent = { info: () => {}, warn: () => {} }
const linuxOnly = process.platform !== 'linux'
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
const LAUNCHER = fileURLToPath(new URL('./fixtures/host-shim-launcher.ts', import.meta.url))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The holder's side: a real dialer over the shim's unix socket, bound to a real session. */
async function bind(
  shim: Pick<HostShim, 'socketPath' | 'token'>,
  subject: string
): Promise<{ session: ShimSession; dialer: ShimDialer }> {
  const session = new ShimSession(subject, 1, {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
  })
  const dialer = new ShimDialer({
    verifier: {
      reviewToken: async (presented) =>
        presented === shim.token
          ? { authenticated: true, podName: subject, podUid: subject }
          : { authenticated: false, error: 'not this shim' }
    },
    dial: (url, options) =>
      ClientTransport.dial(url, { ...options, createConnection: () => connect(shim.socketPath) }) as never,
    onConnection: (connection) => session.attach(connection),
    log: silent
  })
  await dialer.connect(
    'ws://localhost',
    { agentId: 'agent-1', subject, sandboxUid: subject, generation: 1, grants: ['acp'], podName: subject },
    30_000
  )
  return { session, dialer }
}

// The runtime leaves a grandchild in a group of its own, which no group signal from the launcher reaches; it ends itself if a test does not.
const RUNTIME = [
  "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' })",
  'c.unref()',
  "require('fs').writeFileSync('info', [process.pid, process.env.HOME, process.ppid, c.pid].join('\\n'))",
  'process.stdin.pipe(process.stdout)'
].join('; ')

/** Start an echo runtime through the shim, send one line, and return what came back with the pids and HOME it saw. */
async function echoThrough(session: ShimSession, cwd: string, line: string) {
  const opened = (await session.request('acp', {
    op: 'open',
    command: process.execPath,
    args: ['-e', RUNTIME],
    env: { PATH: process.env.PATH ?? '' },
    cwd
  })) as { streamId: string }
  let echoed = ''
  session.onEvent((event) => {
    if (event.streamId === opened.streamId && event.event.kind === 'chunk') {
      echoed += Buffer.from(event.event.data, 'base64').toString()
    }
  })
  await session.request('acp', { op: 'chunk', streamId: opened.streamId, data: Buffer.from(line).toString('base64') })
  await vi.waitFor(() => expect(echoed).toBe(line), WAIT)
  const [pid, home, shimPid, grandchild] = readFileSync(join(cwd, 'info'), 'utf8').split('\n')
  return { echoed, home, pid: Number(pid), shimPid: Number(shimPid), grandchild: Number(grandchild) }
}

describe('host strategy shim launcher', () => {
  let root: string | undefined
  const started: Array<{ shim: HostShim; dialer?: ShimDialer }> = []

  const launchers: ChildProcess[] = []
  const dialers: ShimDialer[] = []

  afterEach(async () => {
    for (const { shim, dialer } of started.splice(0)) {
      dialer?.stop()
      await shim.stop()
    }
    for (const dialer of dialers.splice(0)) dialer.stop()
    for (const launcher of launchers.splice(0)) launcher.kill('SIGKILL')
    // Whatever a failed case left running carries a mark its runtime root still names.
    if (root) await sweepStaleHostShims(root)
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  it.skipIf(linuxOnly)(
    'ends the shim, its runtime and what that left running once the process that started it is killed',
    { timeout: 120_000 },
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-hs-'))
      // A launcher of its own, so the process killed is the shim's parent and not this test runner.
      const launcher = spawn(process.execPath, [...entry.execArgv, LAUNCHER, root, 'sess-a', JSON.stringify(entry)], {
        stdio: ['ignore', 'pipe', 'inherit']
      })
      launchers.push(launcher)
      const where = await new Promise<Pick<HostShim, 'socketPath' | 'token'>>((resolve, reject) => {
        let out = ''
        launcher.stdout!.on('data', (chunk: Buffer) => {
          out += chunk.toString()
          if (out.includes('\n')) resolve(JSON.parse(out) as Pick<HostShim, 'socketPath' | 'token'>)
        })
        launcher.once('exit', () => reject(new Error('the launcher exited before it reported its shim')))
      })
      const { session, dialer } = await bind(where, 'subject-orphan')
      dialers.push(dialer)
      const echo = await echoThrough(session, join(root, 'sessions', 'sess-a', 'workspace'), 'hello\n')
      const pids = { shim: echo.shimPid, runtime: echo.pid, grandchild: echo.grandchild }
      // A survivor is named with its kernel state, so a failure says who outlived the launcher and how; a zombie runs nothing and is not one.
      const survivors = (): string[] =>
        Object.entries(pids)
          .filter(([, pid]) => alive(pid))
          .map(([role, pid]) => `${role} ${readFileSync(`/proc/${pid}/stat`, 'latin1').split(') ')[1]?.[0]}`)
          .filter((entry) => !entry.endsWith(' Z'))
      expect(survivors()).toHaveLength(3)

      // No stop, no signal to the shim: only the descriptor its parent held closes.
      launcher.kill('SIGKILL')
      await vi.waitFor(() => expect(survivors()).toEqual([]), WAIT)
    }
  )

  it.skipIf(linuxOnly)('sweeps a stale runtime root by the mark it names, and nothing else', async () => {
    root = await mkdtemp(join(tmpdir(), 'ac-hs-'))
    const mark = 'ab'.repeat(16)
    const idle = ['-e', 'setTimeout(() => {}, 120000)']
    const marked = spawn(process.execPath, idle, { stdio: 'ignore', env: { AC_SHIM_RUNTIME_MARK: mark } })
    const bystander = spawn(process.execPath, idle, { stdio: 'ignore', env: { AC_SHIM_RUNTIME_MARK: `${mark}0` } })
    launchers.push(marked, bystander)
    const gone = new Promise<NodeJS.Signals | null>((resolve) =>
      marked.once('exit', (_code, signal) => resolve(signal))
    )
    await mkdir(join(root, 'hs', 'stale'), { recursive: true })
    await writeFile(join(root, 'hs', 'stale', 'mark'), mark)
    // A root with no readable mark is only removed.
    await mkdir(join(root, 'hs', 'unmarked'))
    await sweepStaleHostShims(root)
    expect(await gone).toBe('SIGKILL')
    expect(existsSync(join(root, 'hs', 'stale')) || existsSync(join(root, 'hs', 'unmarked'))).toBe(false)
    expect(bystander.exitCode ?? bystander.signalCode).toBeNull()
  })

  it.skipIf(linuxOnly)(
    'runs two sessions side by side, each on its own socket and root, and leaves nothing of one behind on stop',
    { timeout: 120_000 },
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-hs-'))
      const shims = await Promise.all(
        ['sess-a', 'sess-b'].map((sessionLeaf) => startHostShim({ daemonRoot: root!, sessionLeaf, entry }))
      )
      for (const shim of shims) started.push({ shim })
      const [a, b] = shims as [HostShim, HostShim]
      expect(a.runtimeRoot).not.toBe(b.runtimeRoot)
      expect(a.token).not.toBe(b.token)
      for (const shim of shims) {
        expect(shim.socketPath).toBe(join(shim.runtimeRoot, 'shim.sock'))
        expect(statSync(shim.runtimeRoot).mode & 0o777).toBe(0o700)
        for (const dir of ['workspace', 'repos', 'home']) {
          expect(statSync(join(shim.workspaceRoot, dir)).mode & 0o777).toBe(0o700)
        }
        // The source tree ships no helper beside the entry, and the launcher says so instead of naming a path that is not there.
        expect(shim.missingHelpers).toContain('gitCredentialHelper')
      }
      const bound = await Promise.all(shims.map((shim, i) => bind(shim, `subject-${i}`)))
      bound.forEach(({ dialer }, i) => (started[i]!.dialer = dialer))
      const echoes = await Promise.all(
        bound.map(({ session }, i) => echoThrough(session, join(shims[i]!.workspaceRoot, 'workspace'), `hello ${i}\n`))
      )
      expect(echoes.map((echo) => echo.echoed)).toEqual(['hello 0\n', 'hello 1\n'])
      // No complete environment: the holder sent no HOME, and each runtime got its own session's.
      expect(echoes.map((echo) => echo.home)).toEqual(shims.map((shim) => join(shim.workspaceRoot, 'home')))
      // The sweep for an earlier life's leftovers leaves this life's shims and their runtimes alone.
      await sweepStaleHostShims(root)
      expect(shims.every((shim) => existsSync(shim.socketPath))).toBe(true)

      // A process of this user that carries no mark, which no sweep may touch.
      const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
      try {
        await a.stop()
        expect(existsSync(a.runtimeRoot)).toBe(false)
        expect(await a.exited).toBeDefined()
        await vi.waitFor(() => expect(alive(echoes[0]!.pid) || alive(echoes[0]!.grandchild)).toBe(false), WAIT)
        // The neighbour is untouched: its root, its runtime and what that left running, and the session's workspace stays.
        expect(existsSync(b.socketPath)).toBe(true)
        expect(alive(echoes[1]!.pid) && alive(echoes[1]!.grandchild)).toBe(true)
        expect(existsSync(a.workspaceRoot)).toBe(true)

        // A shim killed outright ends nothing itself: the launcher's sweep finds the runtime and the grandchild by their mark.
        process.kill(echoes[1]!.shimPid, 'SIGKILL')
        await b.exited
        await vi.waitFor(() => expect(alive(echoes[1]!.pid) || alive(echoes[1]!.grandchild)).toBe(false), WAIT)
        await vi.waitFor(() => expect(existsSync(b.runtimeRoot)).toBe(false), WAIT)
        expect(bystander.exitCode ?? bystander.signalCode).toBeNull()
      } finally {
        bystander.kill('SIGKILL')
      }
    }
  )

  it.skipIf(linuxOnly)('refuses a session leaf that is not one path segment', async () => {
    await expect(startHostShim({ daemonRoot: '/nonexistent', sessionLeaf: '../x', entry })).rejects.toThrow(
      'invalid session leaf'
    )
  })

  it.skipIf(!linuxOnly)('refuses to start off Linux, with the reason', async () => {
    await expect(startHostShim({ daemonRoot: '/nonexistent', sessionLeaf: 'sess', entry })).rejects.toThrow(
      /needs Linux.*fd-bound.*image-fixed/
    )
  })

  it('names the reason for every platform but Linux', () => {
    expect(hostShimUnavailableReason('linux')).toBeUndefined()
    for (const platform of ['darwin', 'win32'] as const) {
      expect(hostShimUnavailableReason(platform)).toMatch(/needs Linux.*fd-bound.*image-fixed/)
    }
  })

  it('launches the shim with the machine facts and its own roots, and never the complete-environment flag', () => {
    const env = hostShimEnv({
      machineEnv: {
        PATH: '/usr/bin',
        LANG: 'C.UTF-8',
        HOME: '/home/op',
        AC_CLAUDE_API_KEY: 'k',
        AC_SHIM_COMPLETE_ENV: '1'
      },
      home: '/d/sessions/s/home',
      socketPath: '/d/hs/x/shim.sock',
      runtimeRoot: '/d/hs/x',
      workspaceRoot: '/d/sessions/s',
      helperRoot: '/d/dist',
      mark: 'm'
    })
    expect(env).toEqual({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HOME: '/d/sessions/s/home',
      AC_SHIM_SOCKET: '/d/hs/x/shim.sock',
      AC_SHIM_RUNTIME_ROOT: '/d/hs/x',
      AC_SHIM_WORKSPACE_ROOT: '/d/sessions/s',
      AC_SHIM_HELPER_ROOT: '/d/dist',
      AC_SHIM_RUNTIME_MARK: 'm',
      AC_SHIM_PARENT_FD: '3'
    })
  })

  it("carries what the HOME seed points at, which can name none of the shim's own sockets, roots or HOME", () => {
    const env = hostShimEnv({
      machineEnv: { PATH: '/usr/bin' },
      seedEnv: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/home/op/.claude', HOME: '/home/op', AC_SHIM_SOCKET: '/tmp/x' },
      home: '/d/sessions/s/home',
      socketPath: '/d/hs/x/shim.sock',
      runtimeRoot: '/d/hs/x',
      workspaceRoot: '/d/sessions/s',
      helperRoot: '/d/dist',
      mark: 'm'
    })
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/home/op/.claude')
    expect(env.HOME).toBe('/d/sessions/s/home')
    expect(env.AC_SHIM_SOCKET).toBe('/d/hs/x/shim.sock')
  })
})

describe('effective strategy table', () => {
  it('offers host on Linux and microsandbox when its probe is clean', () => {
    expect(effectiveStrategies({ platform: 'linux', microsandbox: { configured: true } })).toEqual({
      host: { available: true },
      microsandbox: { available: true }
    })
  })

  it('reports each unavailable strategy with its reason', () => {
    const table = effectiveStrategies({ platform: 'darwin', microsandbox: { configured: true, unavailable: 'no KVM' } })
    expect(table.host).toEqual({ available: false, reason: expect.stringContaining('needs Linux') })
    expect(table.microsandbox).toEqual({ available: false, reason: 'no KVM' })
    expect(effectiveStrategies({ platform: 'linux', microsandbox: { configured: false } }).microsandbox).toEqual({
      available: false,
      reason: 'microsandbox is not the configured sandbox backend'
    })
  })
})

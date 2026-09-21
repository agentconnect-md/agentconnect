import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, type TLSSocket } from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ClientTransport } from '@agentconnect.md/connection'
import type { ExecutorPrepareReq, ExecutorPrepareResult } from '@agentconnect.md/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionKeyDirName } from '../src/acp/host-key.js'
import { startExecutorFacet, type ExecutorFacet } from '../src/execution/executor-facet.js'
import { PIPE_TLS } from '../src/execution/executor-pipe.js'
import { startHostShim } from '../src/execution/host-shim.js'
import { effectiveStrategies } from '../src/execution/strategies.js'
import { ShimDialer } from '../src/shim/dialer.js'
import { ShimSession } from '../src/shim/session.js'
import { WAIT } from './wait-support.js'

// The one case that needs a real host shim, so it runs on Linux only: the whole path a holder takes, over a real pipe.
const AGENT = '11111111-1111-4111-8111-111111111111'
const SELF = '33333333-3333-4333-8333-333333333333'
const KEY = `slack:C1:1700000000.000100:${AGENT}`
const LEAF = sessionKeyDirName(KEY)
const quiet = { trace() {}, debug() {}, info() {}, warn() {}, error() {} }
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
// An echo runtime that says who it is: its pid, the HOME it was given, and the shim that started it.
const RUNTIME = [
  "require('fs').writeFileSync('info', [process.pid, process.env.HOME, process.ppid].join('\\n'))",
  'process.stdin.pipe(process.stdout)'
].join('; ')

type Ready = Extract<ExecutorPrepareResult, { status: 'ready' }>

/** The local addresses of the TCP sockets a process listens on, read from the kernel's tables. */
function listeningTcp(pid: number): string[] {
  const inodes = new Set<string>()
  for (const fd of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const inode = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`))?.[1]
      if (inode) inodes.add(inode)
    } catch {
      /* closed since the listing */
    }
  }
  const listening: string[] = []
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let rows: string[]
    try {
      rows = readFileSync(table, 'utf8').split('\n').slice(1)
    } catch {
      continue
    }
    for (const row of rows) {
      // sl, local_address, rem_address, st (0A is LISTEN), …, inode is the tenth column.
      const cols = row.trim().split(/\s+/)
      if (cols[3] === '0A' && inodes.has(cols[9] ?? '')) listening.push(cols[1]!)
    }
  }
  return listening
}

describe('executor facet, end to end', () => {
  let root: string | undefined
  let facet: ExecutorFacet | undefined
  const dialers: ShimDialer[] = []

  afterEach(async () => {
    for (const dialer of dialers.splice(0)) dialer.stop()
    await facet?.stop()
    facet = undefined
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  const req = (launch: number): ExecutorPrepareReq => ({
    agentId: AGENT,
    sessionKey: KEY,
    executorDaemonId: SELF,
    launchId: `55555555-5555-4555-8555-${String(launch).padStart(12, '0')}`,
    strategy: 'host'
  })

  function ready(result: ExecutorPrepareResult): Ready {
    if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`)
    return result
  }

  const pipe = (reply: Ready): TLSSocket =>
    connect({
      host: '127.0.0.1',
      port: reply.endpoint.port,
      ...PIPE_TLS,
      pskCallback: () => ({ psk: Buffer.from(reply.psk, 'base64url'), identity: LEAF })
    })

  /** The holder's side: the unmodified dialer and session, handed the TLS-PSK socket instead of opening one. */
  async function bind(reply: Ready, generation: number): Promise<{ session: ShimSession; lost: Promise<string> }> {
    const session = new ShimSession(LEAF, generation, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout)
    })
    let onLost!: (reason: string) => void
    const lost = new Promise<string>((resolve) => (onLost = resolve))
    const dialer = new ShimDialer({
      // No pod verifier: for an executor the proof is the pipe itself, admitted under a key this session's executor minted.
      dial: (url, options) => ClientTransport.dial(url, { ...options, createConnection: () => pipe(reply) }) as never,
      onConnection: (connection) => session.attach(connection),
      onConnectionLost: (_subject, reason) => onLost(reason),
      log: { info: () => {}, warn: () => {} }
    })
    dialers.push(dialer)
    await dialer.connect(
      'ws://executor.example.test',
      { agentId: AGENT, subject: LEAF, sandboxUid: LEAF, generation, grants: ['acp'], podName: LEAF, peer: 'executor' },
      30_000
    )
    return { session, lost }
  }

  it.skipIf(process.platform !== 'linux')(
    'prepares, admits a TLS-PSK dial, binds the shim through the pipe, echoes over ACP, and rotates the holder out',
    { timeout: 120_000 },
    async () => {
      root = await mkdtemp(join(tmpdir(), 'ac-xe-'))
      facet = await startExecutorFacet({
        daemonRoot: root,
        share: true,
        strategies: () => effectiveStrategies({ microsandbox: { configured: false } }),
        capacity: () => 4,
        ownSessions: () => 0,
        draining: () => false,
        endpointHost: () => '127.0.0.1',
        seedHome: () => {},
        agentsExist: async (agentIds) => new Set(agentIds),
        retentionMs: () => null,
        log: quiet,
        startShim: (input) => startHostShim({ ...input, entry }),
        listen: { host: '127.0.0.1' }
      })
      const first = ready(await facet.prepare(req(1)))
      expect(first.liveCount).toBe(1)
      expect(first.helperRoot).toBe(fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, ''))
      // The shim listens on a unix socket in a directory only this user can enter, and on nothing else.
      expect(statSync(first.runtimeRoot).mode & 0o777).toBe(0o700)
      expect(statSync(join(first.runtimeRoot, 'shim.sock')).isSocket()).toBe(true)

      // The holder binds at the generation the executor allocated and returned; it has no counter of its own.
      const holder = await bind(first, first.generation)
      const workspace = join(root, 'sessions', LEAF, 'workspace')
      const opened = (await holder.session.request('acp', {
        op: 'open',
        command: process.execPath,
        args: ['-e', RUNTIME],
        env: { PATH: process.env.PATH ?? '' },
        cwd: workspace
      })) as { streamId: string }
      let echoed = ''
      holder.session.onEvent((event) => {
        if (event.streamId === opened.streamId && event.event.kind === 'chunk') {
          echoed += Buffer.from(event.event.data, 'base64').toString()
        }
      })
      await holder.session.request('acp', {
        op: 'chunk',
        streamId: opened.streamId,
        data: Buffer.from('hello executor\n').toString('base64')
      })
      await vi.waitFor(() => expect(echoed).toBe('hello executor\n'), WAIT)
      const [, home, shimPid] = readFileSync(join(workspace, 'info'), 'utf8').split('\n')
      // The runtime ran under the session's own HOME on this machine, which the holder never named.
      expect(home).toBe(join(root, 'sessions', LEAF, 'home'))
      // From another machine the TLS-PSK port is the only way in: the facet's listener is there, and the shim owns no TCP listener at all.
      const port = first.endpoint.port.toString(16).toUpperCase().padStart(4, '0')
      expect(listeningTcp(process.pid)).toContain(`0100007F:${port}`)
      expect(listeningTcp(Number(shimPid))).toEqual([])

      // A newer launch rotates: the pipe admitted under the old key closes, and that key admits nobody.
      const second = ready(await facet.prepare(req(2)))
      expect(second.psk).not.toBe(first.psk)
      expect(second.generation).toBe(first.generation + 1)
      expect(second.runtimeRoot).toBe(first.runtimeRoot)
      await holder.lost
      dialers.shift()!.stop()
      await expect(
        new Promise((resolve, reject) => pipe(first).once('secureConnect', resolve).once('error', reject))
      ).rejects.toThrow(/decrypt error/i)
      // The successor binds the same shim at its higher generation, through its own pipe.
      await bind(second, second.generation)

      // Inside this case's budget, not the hook's: stopping ends the shim and the runtime it started.
      for (const dialer of dialers.splice(0)) dialer.stop()
      await facet.stop()
      facet = undefined
      expect(statSync(join(root, 'sessions', LEAF, 'workspace')).isDirectory()).toBe(true)
    }
  )
})

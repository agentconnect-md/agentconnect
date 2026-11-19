import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LoopbackGuard } from './loopback-guard.js'
import { fakeProc, type FakeProcess } from './testing.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function profileDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'loopback-guard-')))
  dirs.push(dir)
  const profile = join(dir, 'browser', 'main')
  mkdirSync(profile, { recursive: true })
  return profile
}

const CHROME = '/opt/google/chrome/chrome'
const DAEMON = 4242

// A desktop browser (pid 100) on `profile`, a child of it (140), and the daemon itself, holding the given sockets.
function processes(profile: string, sockets: { browser?: string[]; child?: string[]; daemon?: string[] }) {
  const fds = (inodes: string[] = []) =>
    Object.fromEntries(inodes.map((inode, i) => [`${20 + i}`, `socket:[${inode}]`]))
  return {
    1: { exe: '/usr/bin/tini', title: '/usr/bin/tini', ppid: 0, fds: {} },
    100: {
      exe: CHROME,
      title: `${CHROME} --user-data-dir=${profile} --remote-debugging-port=0`,
      ppid: 1,
      fds: { '40': `${profile}/Default/History`, ...fds(sockets.browser) }
    },
    140: { exe: CHROME, title: `${CHROME} --type=utility`, ppid: 100, fds: fds(sockets.child) },
    [DAEMON]: {
      exe: '/usr/local/bin/node',
      title: 'node agentconnect-computer.mjs run',
      ppid: 1,
      fds: fds(sockets.daemon)
    }
  } satisfies Record<number, FakeProcess>
}

const guard = (options: Partial<ConstructorParameters<typeof LoopbackGuard>[0]> = {}) =>
  new LoopbackGuard({ daemonPorts: () => [], profiles: () => [], pid: DAEMON, interfaces: () => [], ...options })

describe('loopback guard (computer-use.md §5.8)', () => {
  it('knows every form of this machine’s loopback, and its interface addresses', () => {
    const local = guard({ interfaces: () => ['127.0.0.1', '::1', '192.0.2.10', '2001:db8::10', 'fe80::1'] })
    for (const address of [
      '127.0.0.1',
      '127.255.0.9',
      '::1',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0.0.0.0',
      '0.1.2.3',
      '::',
      '::ffff:0.0.0.0',
      '192.0.2.10',
      '::ffff:192.0.2.10',
      '2001:db8::10',
      'fe80::1%eth0'
    ])
      expect(local.isLocal(address), address).toBe(true)
    for (const address of ['192.0.2.11', '198.51.100.7', '2001:db8::11', '::ffff:198.51.100.7', 'localhost', ''])
      expect(local.isLocal(address), address).toBe(false)
  })

  it('refuses the daemon’s named ports and any socket the daemon itself listens on', async () => {
    const profile = profileDir()
    const proc = fakeProc({ '700': 7700 }, processes(profile, { daemon: ['700'] }))
    const check = guard({ proc, daemonPorts: () => [7681, undefined], profiles: () => [profile] })
    expect(await check.refusal(7681)).toBe('daemon listener')
    expect(await check.refusal(7700)).toBe('daemon listener')
    expect(await check.refusal(3000)).toBeUndefined()
  })

  it('refuses every port a desktop browser’s processes listen on, and no other browser’s', async () => {
    const profile = profileDir()
    const listeners: Record<string, number> = { '900': 9222, '901': 41234, '902': 3000 }
    const proc = fakeProc(listeners, processes(profile, { browser: ['900'], child: ['901'] }))
    const check = guard({ proc, profiles: () => [profile] })
    expect(await check.refusal(9222)).toBe('browser port')
    expect(await check.refusal(41234)).toBe('browser port')
    // Held by nobody it can read: an agent's dev server.
    expect(await check.refusal(3000)).toBeUndefined()
    const other = guard({ proc, profiles: () => [join(profile, '..', 'other')] })
    expect(await other.refusal(9222)).toBeUndefined()
  })

  it('finds a browser that starts after the first check', async () => {
    const profile = profileDir()
    const listeners: Record<string, number> = {}
    const table: Record<number, FakeProcess> = { ...processes(profile, {}) }
    const check = guard({ proc: fakeProc(listeners, table), profiles: () => [profile] })
    expect(await check.refusal(39001)).toBeUndefined()
    listeners['950'] = 39001
    table[100]!.fds['60'] = 'socket:[950]'
    expect(await check.refusal(39001)).toBe('browser port')
  })

  it('refuses every loopback port while a desktop’s launch lock is held, and not for a stale one', async () => {
    const profile = profileDir()
    const check = guard({ proc: fakeProc({}, {}), profiles: () => [join(profile, '..', 'd1'), profile] })
    expect(await check.refusal(3000)).toBeUndefined()
    writeFileSync(`${profile}.launch-lock`, '')
    expect(await check.refusal(3000)).toBe('browser starting')
    const old = new Date(Date.now() - 120_000)
    utimesSync(`${profile}.launch-lock`, old, old)
    expect(await check.refusal(3000)).toBeUndefined()
  })

  it('refuses every loopback port when it cannot read the socket tables', async () => {
    const check = guard({ proc: fakeProc({}, {}, { unreadable: true }) })
    expect(await check.refusal(3000)).toBe('ports unreadable')
  })

  it('knows a desktop browser by the profile it was started on, before it opens a file there', async () => {
    const profile = profileDir()
    const table: Record<number, FakeProcess> = processes(profile, { browser: ['900'] })
    table[100]!.fds = { '20': 'socket:[900]' }
    const check = guard({ proc: fakeProc({ '900': 9222 }, table), profiles: () => [profile] })
    expect(await check.refusal(9222)).toBe('browser port')
  })

  it('reads the socket tables after each call, sharing one read among the calls that wait for it', async () => {
    const base = fakeProc({}, {})
    const reads: string[] = []
    const check = guard({ proc: { ...base, read: (path) => (reads.push(path), base.read(path)) } })
    expect(await Promise.all([check.refusal(1), check.refusal(2), check.refusal(3)])).toEqual([
      undefined,
      undefined,
      undefined
    ])
    // The first call's read, and one more for the two that arrived while it ran.
    expect(reads).toEqual(['/proc/net/tcp', '/proc/net/tcp6', '/proc/net/tcp', '/proc/net/tcp6'])
  })
})

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChannelAuthority } from '../cp/authority.js'
import { EgressForwarder } from '../egress.js'
import type { ProcFs } from '../form-fill/attribution.js'
import { LoopbackGuard } from '../loopback-guard.js'
import { fakeProc, type FakeProcess } from '../testing.js'
import { devtoolsFlags, devtoolsStatePath, readDevtoolsState } from './devtools-launch.js'
import {
  devtoolsCheck,
  DevtoolsTier,
  dockerDnsSockets,
  effectiveTier,
  namespaceCheck,
  tierGrant,
  type TierGrant,
  type TierInputs
} from './devtools-tier.js'

const dirs: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-devtools-tier-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const node = (fds: Record<string, string>): FakeProcess => ({ exe: '/usr/bin/node', title: 'node', ppid: 1, fds })

// A /proc/net table row: local address and port, remote, state, inode.
const row = (local: string, state: string, inode: string, remote = '00000000:0000') =>
  `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`
const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'

// A fake /proc whose tables hold the given rows, over fakeProc's processes; resolv.conf when given.
function tables(
  base: ProcFs,
  rows: Partial<Record<'tcp' | 'tcp6' | 'udp' | 'udp6', string[]>>,
  resolvConf?: string
): ProcFs & { reads: string[] } {
  const reads: string[] = []
  return {
    ...base,
    reads,
    read: (path) => {
      reads.push(path)
      const table = /^\/proc\/net\/(tcp6?|udp6?)$/.exec(path)?.[1] as keyof typeof rows | undefined
      if (table) return [HEADER, ...(rows[table] ?? [])].join('\n')
      if (path === '/etc/resolv.conf' && resolvConf !== undefined) return resolvConf
      return base.read(path)
    }
  }
}

describe('the network namespace check (computer-use.md §5.8)', () => {
  it('is its own when every socket belongs to a process the daemon can see', () => {
    const proc = fakeProc(
      { '11': 7681, '12': 40_123 },
      { 50: node({ '3': 'socket:[11]' }), 60: node({ '4': 'socket:[12]' }) }
    )
    expect(namespaceCheck(proc)).toEqual({ own: true })
    expect(namespaceCheck(fakeProc({}, {}))).toEqual({ own: true })
  })

  it('is not when a listener has no visible holder: host networking, a sidecar, or another user', () => {
    const proc = fakeProc({ '11': 7681, '21': 15_001, '22': 22 }, { 50: node({ '3': 'socket:[11]' }) })
    expect(namespaceCheck(proc)).toEqual({ own: false, sockets: ['tcp 22', 'tcp 15001'] })
    expect(namespaceCheck(fakeProc({}, {}, { unreadable: true }))).toEqual({ own: false, unreadable: true })
  })

  it('counts a sharer with no listener: a TCP socket in any state, or a UDP socket, and skips inode 0', () => {
    const visible = fakeProc({}, { 50: node({ '3': 'socket:[11]' }) })
    const connected = tables(visible, {
      tcp: [row('0100007F:9C40', '01', '11', '0100007F:1E01'), row('0100007F:9C41', '01', '31', '0100007F:A0A0')]
    })
    expect(namespaceCheck(connected)).toEqual({ own: false, sockets: ['tcp 40001'] })
    const udp = tables(visible, { udp6: [row('00000000000000000000000000000000:14E9', '07', '32')] })
    expect(namespaceCheck(udp)).toEqual({ own: false, sockets: ['udp 5353'] })
    const timeWait = tables(visible, { tcp: [row('0100007F:9C41', '06', '0', '0100007F:A0A0')] })
    expect(namespaceCheck(timeWait)).toEqual({ own: true })
  })

  it('ignores a socket that closed while the processes were read', () => {
    const base = fakeProc({ '11': 7681, '21': 15_001 }, { 50: node({ '3': 'socket:[11]' }) })
    let reads = 0
    const closing: ProcFs = {
      ...base,
      read: (path) => {
        const text = base.read(path)
        if (path !== '/proc/net/tcp') return text
        // The second pass over the tables no longer has the orphan.
        return reads++ < 1
          ? text
          : text
              .split('\n')
              .filter((line) => !line.includes(' 21 '))
              .join('\n')
      }
    }
    expect(namespaceCheck(closing)).toEqual({ own: true })
  })

  it('exempts only the Docker DNS sockets pinned at the first check, and only when resolv.conf names 127.0.0.11', () => {
    const visible = fakeProc({}, {})
    const dns = { tcp: [row('0B00007F:A7AB', '0A', '41')], udp: [row('0B00007F:BAAB', '07', '42')] }
    const docker = 'search example.test\nnameserver 127.0.0.11\noptions ndots:0\n'
    const pinned = dockerDnsSockets(tables(visible, dns, docker))
    expect(pinned).toEqual(new Set(['41', 'local:0B00007F:A7AB', '42']))
    expect(namespaceCheck(tables(visible, dns, docker), pinned)).toEqual({ own: true })
    // A DNS query over TCP is a connection the engine accepted on the pinned listener's own address and port.
    const query = { ...dns, tcp: [...dns.tcp, row('0B00007F:A7AB', '01', '44')] }
    expect(namespaceCheck(tables(visible, query, docker), pinned)).toEqual({ own: true })
    // Only listeners are pinned: a connection open on 127.0.0.11 at the first check is not.
    const open = { ...dns, tcp: [...dns.tcp, row('0B00007F:C350', '01', '45')] }
    expect(dockerDnsSockets(tables(visible, open, docker))).toEqual(new Set(['41', 'local:0B00007F:A7AB', '42']))
    // A sharer's listener on 127.0.0.11 after the first check counts.
    const later = { ...dns, tcp: [...dns.tcp, row('0B00007F:0050', '0A', '43')] }
    expect(namespaceCheck(tables(visible, later, docker), pinned)).toEqual({ own: false, sockets: ['tcp 80'] })
    // The default bridge network names the host's resolvers: nothing on 127.0.0.11 is Docker's.
    expect(dockerDnsSockets(tables(visible, dns, 'nameserver 192.0.2.53\n'))).toEqual(new Set())
    expect(dockerDnsSockets(tables(visible, dns, '# nameserver 127.0.0.11\nnameserver 192.0.2.53\n'))).toEqual(
      new Set()
    )
    expect(dockerDnsSockets(tables(visible, dns))).toEqual(new Set())
  })
})

describe('the effective tier (computer-use.md §5.8)', () => {
  const on: TierInputs = {
    image: true,
    isolation: 'container',
    granted: true,
    namespace: () => ({ own: true }),
    chrome: () => true
  }

  it('is on only when every condition holds', () => {
    expect(effectiveTier(on)).toEqual({ on: true })
    expect(effectiveTier({ ...on, isolation: 'vm' })).toEqual({ on: true })
  })

  it('names the first condition that fails', () => {
    expect(effectiveTier({ ...on, image: false })).toMatchObject({ on: false, reason: 'not the image' })
    expect(effectiveTier({ ...on, isolation: 'none' })).toMatchObject({ on: false, reason: 'not isolated' })
    expect(effectiveTier({ ...on, namespace: () => ({ own: false, sockets: ['tcp 22'] }) })).toEqual({
      on: false,
      reason: 'shared network namespace',
      detail:
        "tcp 22 held by a process this daemon cannot inspect (another user's, for example one started with sudo) or outside this container"
    })
    expect(effectiveTier({ ...on, chrome: () => false })).toMatchObject({ on: false, reason: 'Google Chrome missing' })
    expect(effectiveTier({ ...on, granted: false })).toMatchObject({ on: false, reason: 'off by policy' })
    expect(effectiveTier({ ...on, granted: undefined })).toMatchObject({ on: false, reason: 'waiting for policy' })
  })

  it('reads the grant before the namespace and Chrome, so a desktop without the tier scans nothing', () => {
    const read: string[] = []
    const inputs = (granted: boolean | undefined, image = true): TierInputs => ({
      ...on,
      image,
      granted,
      namespace: () => (read.push('namespace'), { own: false, sockets: ['tcp 22'] }),
      chrome: () => (read.push('chrome'), false)
    })
    expect(effectiveTier(inputs(false))).toMatchObject({ reason: 'off by policy' })
    expect(effectiveTier(inputs(undefined))).toMatchObject({ reason: 'waiting for policy' })
    expect(effectiveTier(inputs(true, false))).toMatchObject({ reason: 'not the image' })
    expect(read).toEqual([])
  })
})

describe('the grant (computer-use.md §5.8)', () => {
  const config = { browserTier: true, browserHideWebdriver: false }

  it("takes an unregistered daemon's config", () => {
    expect(tierGrant({ registered: false, revoked: false, policy: undefined, config })).toEqual({
      granted: true,
      hideWebdriver: false
    })
  })

  it("takes a registered desktop's policy, none before it arrives, and reads absent fields as off and hidden", () => {
    const registered = { registered: true, revoked: false, config }
    expect(tierGrant({ ...registered, policy: undefined })).toBeUndefined()
    expect(tierGrant({ ...registered, policy: {} })).toEqual({ granted: false, hideWebdriver: true })
    expect(tierGrant({ ...registered, policy: { browserTier: true, browserHideWebdriver: false } })).toEqual({
      granted: true,
      hideWebdriver: false
    })
  })

  it('grants nothing to a revoked desktop, whatever its last policy said', () => {
    expect(tierGrant({ registered: true, revoked: true, policy: { browserTier: true }, config })).toEqual({
      granted: false,
      hideWebdriver: true
    })
  })

  it('takes the grant away at a run-time revoke, and the launch state says so', async () => {
    const authority = new ChannelAuthority({ registered: true })
    const dir = temp()
    const controller = new DevtoolsTier({
      dataDir: dir,
      image: true,
      isolation: 'container',
      chrome: () => true,
      grant: () =>
        tierGrant({
          registered: true,
          revoked: authority.state().kind === 'revoked',
          policy: { browserTier: true },
          config
        }),
      registered: true,
      egressPort: 7691,
      startForwarder: async () => 0,
      log: () => undefined,
      proc: fakeProc({}, {})
    })
    await controller.refresh()
    expect(controller.on).toBe(true)
    authority.revoke('computer revoked by the Control Plane')
    await controller.refresh()
    expect(controller.verdict).toMatchObject({ on: false, reason: 'off by policy' })
    expect(readDevtoolsState(dir)).toEqual({ tier: false, hideWebdriver: true })
  })
})

describe('DevtoolsTier (computer-use.md §5.8, §15.4)', () => {
  function tier(
    options: { grant?: TierGrant; egressPort?: number; proc?: ProcFs; fail?: boolean; policyWaitMs?: number } = {}
  ) {
    const state = {
      dir: temp(),
      grant: 'grant' in options ? options.grant : ({ granted: true, hideWebdriver: true } as TierGrant | undefined),
      chrome: true,
      starts: [] as (number | undefined)[],
      lines: [] as string[],
      changes: 0
    }
    const controller = new DevtoolsTier({
      dataDir: state.dir,
      image: true,
      isolation: 'container',
      chrome: () => state.chrome,
      grant: () => state.grant,
      registered: false,
      egressPort: options.egressPort,
      startForwarder: async () => {
        state.starts.push(41_000)
        if (options.fail) throw new Error('EADDRINUSE')
        return 41_000
      },
      log: (line) => state.lines.push(line),
      onChange: () => void state.changes++,
      proc: options.proc ?? fakeProc({}, {}),
      ...(options.policyWaitMs !== undefined ? { policyWaitMs: options.policyWaitMs } : {})
    })
    return { state, controller }
  }

  it("writes the launch state, and starts the daemon's own forwarder once for a self-hosted container", async () => {
    const { state, controller } = tier()
    await controller.refresh()
    expect(controller.on).toBe(true)
    expect(readDevtoolsState(state.dir)).toEqual({ tier: true, hideWebdriver: true, egressPort: 41_000 })
    expect(devtoolsFlags(readDevtoolsState(state.dir), true, {})).toEqual([
      '--remote-debugging-port=0',
      '--disable-blink-features=AutomationControlled',
      '--proxy-server=http://127.0.0.1:41000',
      '--proxy-bypass-list=<-loopback>;127.0.0.1:7682'
    ])
    await controller.refresh()
    expect(state.starts).toEqual([41_000])
    expect(state.lines).toEqual(['browser tier: on'])
    expect(state.changes).toBe(1)
  })

  it('turns the tier off when no forwarder starts, so no browser gets the endpoint without one', async () => {
    const failing = tier({ fail: true })
    await failing.controller.refresh()
    expect(failing.controller.verdict).toMatchObject({ on: false, reason: 'no egress forwarder' })
    expect(readDevtoolsState(failing.state.dir)).toEqual({ tier: false, hideWebdriver: true })
  })

  it("leaves a managed pod's forwarder to the pod", async () => {
    const { state, controller } = tier({ egressPort: 7691 })
    await controller.refresh()
    expect(state.starts).toEqual([])
    expect(readDevtoolsState(state.dir)).toEqual({ tier: true, hideWebdriver: true })
  })

  it('writes the webdriver choice and the tier going off, and drops the forwarder from the state', async () => {
    const { state, controller } = tier()
    await controller.refresh()
    state.grant = { granted: true, hideWebdriver: false }
    await controller.refresh()
    expect(readDevtoolsState(state.dir)).toEqual({ tier: true, hideWebdriver: false, egressPort: 41_000 })
    state.grant = { granted: false, hideWebdriver: false }
    await controller.refresh()
    expect(readDevtoolsState(state.dir)).toEqual({ tier: false, hideWebdriver: false })
    expect(state.lines).toEqual(['browser tier: on', 'browser tier: off (off by policy)'])
  })

  it('writes nothing while a registered desktop waits for its policy, so a launch waits instead', async () => {
    const { state, controller } = tier({ grant: undefined })
    await controller.refresh()
    expect(existsSync(devtoolsStatePath(state.dir))).toBe(false)
    state.grant = { granted: true, hideWebdriver: true }
    await controller.refresh()
    expect(readDevtoolsState(state.dir)?.tier).toBe(true)
  })

  it('turns off while the namespace is shared, and logs the reason once', async () => {
    const shared = fakeProc({ '21': 15_001 }, {})
    const { state, controller } = tier({ proc: shared })
    await controller.refresh()
    await controller.refresh()
    expect(controller.verdict).toMatchObject({ on: false, reason: 'shared network namespace' })
    expect(readDevtoolsState(state.dir)).toEqual({ tier: false, hideWebdriver: true })
    expect(state.lines).toEqual([
      "browser tier: off (shared network namespace: tcp 15001 held by a process this daemon cannot inspect (another user's, for example one started with sudo) or outside this container)"
    ])
    expect(state.starts).toEqual([])
  })

  it('reads no socket table while the tier is not granted', async () => {
    const proc = tables(fakeProc({}, {}), { tcp: [row('0100007F:3A99', '0A', '21')] })
    const { state, controller } = tier({ proc, grant: { granted: false, hideWebdriver: true } })
    await controller.refresh()
    expect(proc.reads.filter((path) => path.startsWith('/proc/net/'))).toEqual([])
    state.grant = { granted: true, hideWebdriver: true }
    await controller.refresh()
    expect(controller.verdict).toMatchObject({ reason: 'shared network namespace' })
  })

  it('stops launches waiting once no policy came in time, and the first policy overwrites that', async () => {
    const { state, controller } = tier({ grant: undefined, policyWaitMs: 20 })
    await controller.start()
    try {
      expect(existsSync(devtoolsStatePath(state.dir))).toBe(false)
      await expect.poll(() => readDevtoolsState(state.dir)).toEqual({ tier: false, hideWebdriver: true })
      expect(controller.verdict).toMatchObject({ reason: 'waiting for policy' })
      state.grant = { granted: true, hideWebdriver: false }
      await controller.refresh()
      expect(readDevtoolsState(state.dir)).toEqual({ tier: true, hideWebdriver: false, egressPort: 41_000 })
    } finally {
      controller.stop()
    }
  })
})

describe("doctor's devtools check (computer-use.md §3.5)", () => {
  const ok = {
    desktop: 'main',
    pid: 100,
    status: 'ok' as const,
    endpoint: { port: 40_123, path: '/devtools/browser/x' }
  }

  it('says on, with each browser’s endpoint port and never its id', () => {
    const check = devtoolsCheck({ on: true }, [ok, { desktop: 'd1', pid: 200, status: 'pending' }], false)
    expect(check).toEqual({ name: 'devtools', status: 'ok', detail: 'on: main on port 40123, d1 starting' })
    expect(devtoolsCheck({ on: true }, [], false).detail).toBe('on: no desktop browser is running')
  })

  it('says why it is unavailable or off', () => {
    const detail = (reason: Parameters<typeof devtoolsCheck>[0], registered = false) =>
      devtoolsCheck(reason, [], registered)
    expect(detail({ on: false, reason: 'not the image' })).toMatchObject({
      status: 'info',
      detail: 'unavailable: not the Computer image'
    })
    expect(detail({ on: false, reason: 'not isolated' }).detail).toBe('unavailable: not an isolated Computer')
    expect(
      detail({
        on: false,
        reason: 'shared network namespace',
        detail:
          "tcp 22 held by a process this daemon cannot inspect (another user's, for example one started with sudo) or outside this container"
      })
    ).toEqual({
      name: 'devtools',
      status: 'warn',
      detail:
        "unavailable: the network namespace is not its own (tcp 22 held by a process this daemon cannot inspect (another user's, for example one started with sudo) or outside this container)",
      fix: 'stop any process here that runs as another user (sudo, a service user), and run the container in a network namespace of its own: no host networking, no --network container:, no sidecar'
    })
    expect(detail({ on: false, reason: 'Google Chrome missing' })).toMatchObject({
      status: 'warn',
      detail: 'unavailable: Google Chrome missing'
    })
    expect(detail({ on: false, reason: 'off by policy' }).detail).toBe('off by policy (browserTier in config.json)')
    expect(detail({ on: false, reason: 'off by policy' }, true).detail).toBe('off by policy')
    expect(detail({ on: false, reason: 'waiting for policy' }, true).detail).toBe(
      "off until the Control Plane's policy arrives"
    )
  })

  it('warns when an endpoint was not found or failed its self-test', () => {
    expect(devtoolsCheck({ on: true }, [{ desktop: 'main', pid: 1, status: 'not found' }], false)).toMatchObject({
      status: 'warn',
      detail: 'on: main: endpoint not found'
    })
    expect(devtoolsCheck({ on: true }, [{ ...ok, status: 'self-test failed' }], false)).toMatchObject({
      status: 'warn',
      detail: 'on: main: self-test failed'
    })
  })

  it("warns about a port a browser listens on besides the endpoint, such as the checkbox's 9222", () => {
    expect(devtoolsCheck({ on: true }, [{ ...ok, extra: [9222] }], false)).toMatchObject({
      status: 'warn',
      detail: "on: main on port 40123; main's browser also listens on 9222"
    })
    expect(
      devtoolsCheck(
        { on: false, reason: 'off by policy' },
        [{ desktop: 'main', pid: 1, status: 'pending', extra: [9222] }],
        false
      )
    ).toMatchObject({
      status: 'warn',
      detail: "off by policy (browserTier in config.json); main's browser also listens on 9222"
    })
  })
  it('reports a browser started before the tier as information, not a fault', () => {
    expect(devtoolsCheck({ on: true }, [ok, { desktop: 'd1', pid: 200, status: 'before the tier' }], false)).toEqual({
      name: 'devtools',
      status: 'info',
      detail: 'on: main on port 40123, d1: started before the tier turned on, gets the endpoint at its next start'
    })
  })

  it('warns about a browser started with switches the launcher does not pass', () => {
    expect(devtoolsCheck({ on: true }, [{ ...ok, status: 'refused switches' }], false)).toMatchObject({
      status: 'warn',
      detail: 'on: main: started with switches the launcher does not pass'
    })
  })

  it('words the endpoint a browser keeps after the tier went off apart from the checkbox case', () => {
    const check = devtoolsCheck(
      { on: false, reason: 'off by policy' },
      [{ desktop: 'main', pid: 1, status: 'pending', kept: 40_123 }],
      true
    )
    expect(check).toEqual({
      name: 'devtools',
      status: 'info',
      detail:
        "off by policy; main's browser still has the endpoint from when the tier was on (port 40123); it closes at the browser's next start"
    })
  })
})

describe("the self-hosted container's forwarder (computer-use.md §15.4)", () => {
  it('serves the browser directly on the port the launch state names, with the loopback refusal in front', async () => {
    const site = createServer((_req, res) => res.end('dev server'))
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
    const sitePort = (site.address() as AddressInfo).port
    let forwarder: EgressForwarder | undefined
    const dir = temp()
    const controller = new DevtoolsTier({
      dataDir: dir,
      image: true,
      isolation: 'container',
      chrome: () => true,
      grant: () => ({ granted: true, hideWebdriver: true }),
      registered: false,
      egressPort: undefined,
      startForwarder: async () => {
        forwarder = new EgressForwarder({
          port: 0,
          log: () => undefined,
          loopback: new LoopbackGuard({ daemonPorts: () => [], profiles: () => [], proc: fakeProc({}, {}) })
        })
        await forwarder.start()
        forwarder.apply({ mode: 'direct' })
        return forwarder.port!
      },
      log: () => undefined,
      proc: fakeProc({}, {})
    })
    try {
      await controller.refresh()
      const port = readDevtoolsState(dir)?.egressPort
      expect(port).toBe(forwarder?.port)
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: `http://127.0.0.1:${sitePort}/`,
            headers: { host: `127.0.0.1:${sitePort}` }
          },
          (res) => {
            let text = ''
            res.on('data', (chunk: Buffer) => (text += chunk.toString()))
            res.on('end', () => resolve(text))
          }
        )
        req.on('error', reject)
        req.end()
      })
      expect(body).toBe('dev server')
    } finally {
      await forwarder?.stop()
      await new Promise((resolve) => site.close(resolve))
    }
  })
})

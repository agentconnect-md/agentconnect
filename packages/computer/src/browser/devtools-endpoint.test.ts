import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeProc } from '../testing.js'
import {
  browserPorts,
  commandLineProblem,
  DevtoolsEndpoints,
  foreignOriginRefused,
  parsePortFile,
  processStartMs,
  readPortFile,
  versionPath,
  type PortFileReader,
  type SelfTestOutcome
} from './devtools-endpoint.js'

const UUID = '6f0c8c3e-2a51-4d7e-9a44-0d2f3b1c9e10'
const PATH = `/devtools/browser/${UUID}`

const servers: Server[] = []
const sockets = new Set<Socket>()
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.on('connection', (socket: Socket) => sockets.add(socket.once('close', () => sockets.delete(socket))))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('the port file (computer-use.md §3.10)', () => {
  it('reads `<port>\\n/devtools/browser/<uuid>` with no trailing newline, and nothing else', () => {
    expect(parsePortFile(`40123\n${PATH}`)).toEqual({ port: 40_123, path: PATH })
    for (const text of [
      `40123\n${PATH}\n`,
      `0\n${PATH}`,
      `70000\n${PATH}`,
      `40123\n/devtools/page/${UUID}`,
      '',
      '40123'
    ])
      expect(parsePortFile(text), JSON.stringify(text)).toBeUndefined()
  })

  it('takes a process start time from its stat start ticks and the boot time', () => {
    const stat = (ticks: number) =>
      `77 (chrome (main)) S 1 77 77 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 30 0 ${ticks} 1000 200 18446744073709551615`
    const proc = {
      read: (path: string) => {
        if (path === '/proc/77/stat') return stat(123_456)
        if (path === '/proc/stat') return 'cpu  1 2 3\nbtime 1700000000\nprocesses 9'
        throw new Error(`ENOENT ${path}`)
      },
      list: () => [],
      link: () => ''
    }
    expect(processStartMs(proc, 77)).toBe(1_700_000_000_000 + 1_234_560)
    expect(processStartMs(proc, 78)).toBeUndefined()
  })

  it('accepts only a file written after its browser started: the file outlives every browser', () => {
    let mtime = 10_000
    const files: PortFileReader = { mtimeMs: () => mtime, read: () => `40123\n${PATH}` }
    expect(readPortFile('/profile', 9_000, files)).toEqual({ port: 40_123, path: PATH })
    // Within the start time's own tick.
    expect(readPortFile('/profile', 10_005, files)).toEqual({ port: 40_123, path: PATH })
    mtime = 8_000
    expect(readPortFile('/profile', 9_000, files)).toBeUndefined()
    const missing: PortFileReader = {
      mtimeMs: () => {
        throw new Error('ENOENT')
      },
      read: () => ''
    }
    expect(readPortFile('/profile', 0, missing)).toBeUndefined()
  })

  it("reads /json/version's webSocketDebuggerUrl path on the file's port", async () => {
    const port = await listen(
      createServer((req, res) => {
        if (req.url !== '/json/version') return void res.writeHead(404).end()
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ Browser: 'Chrome/158.0', webSocketDebuggerUrl: `ws://127.0.0.1:1${PATH}` }))
      })
    )
    expect(await versionPath(port)).toBe(PATH)
    const other = await listen(createServer((_req, res) => res.end('not json')))
    expect(await versionPath(other)).toBeUndefined()
  })
})

describe('the self-test (computer-use.md §5.8)', () => {
  it('tells a refusal (403) from an acceptance (an upgrade or any other answer) and from no answer', async () => {
    const origins: (string | undefined)[] = []
    const refusing = createServer()
    refusing.on('upgrade', (req, socket: Socket) => {
      origins.push(req.headers.origin)
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
    })
    expect(await foreignOriginRefused({ port: await listen(refusing), path: PATH })).toBe('refused')
    expect(origins).toHaveLength(1)
    expect(origins[0]).not.toMatch(/^https?:\/\/(127\.0\.0\.1|localhost)/)

    const accepting = createServer()
    accepting.on('upgrade', (_req, socket: Socket) =>
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    )
    expect(await foreignOriginRefused({ port: await listen(accepting), path: PATH })).toBe('accepted')

    const plain = createServer((_req, res) => res.writeHead(404).end())
    expect(await foreignOriginRefused({ port: await listen(plain), path: PATH })).toBe('accepted')

    const closed = await listen(createServer())
    await new Promise((resolve) => servers.pop()!.close(resolve))
    expect(await foreignOriginRefused({ port: closed, path: PATH })).toBe('error')
  })
})

describe("the browser's command line (computer-use.md §5.8)", () => {
  const chrome = '/usr/lib/google/chrome/chrome --user-data-dir=/p --remote-debugging-port=0'
  const proxied = `${chrome} --proxy-server=http://127.0.0.1:41000 --proxy-bypass-list=<-loopback>`

  it("accepts the launcher's switches, in a rewritten title or NUL-separated", () => {
    expect(commandLineProblem(chrome, undefined)).toBeUndefined()
    expect(commandLineProblem(proxied, 41_000)).toBeUndefined()
    expect(commandLineProblem(`${proxied.replaceAll(' ', '\0')}\0`, 41_000)).toBeUndefined()
  })

  it('tells a browser started before the tier from one carrying switches the launcher never passes', () => {
    expect(commandLineProblem('/usr/lib/google/chrome/chrome --user-data-dir=/p', undefined)).toBe('before the tier')
    expect(commandLineProblem(`${chrome} --remote-allow-origins=*`, undefined)).toBe('refused switches')
    expect(commandLineProblem(chrome, 41_000)).toBe('refused switches')
    expect(commandLineProblem(`${proxied} --proxy-server=direct://`, 41_000)).toBe('refused switches')
    expect(commandLineProblem(`${proxied} --no-proxy-server`, 41_000)).toBe('refused switches')
    expect(commandLineProblem(proxied, 7691)).toBe('refused switches')
    // Chrome on POSIX takes a single dash as well, and the check reads the switch as Chrome does.
    expect(commandLineProblem(`${chrome} -remote-allow-origins=https://site.example`, undefined)).toBe(
      'refused switches'
    )
    expect(commandLineProblem(`${proxied} -no-proxy-server`, 41_000)).toBe('refused switches')
    expect(commandLineProblem(`${proxied} -proxy-server=direct://`, 41_000)).toBe('refused switches')
    // After a bare `--` an argument is not a switch, so it opens nothing.
    expect(commandLineProblem(`${proxied} -- --remote-allow-origins=*`, 41_000)).toBeUndefined()
  })
})

describe('browserPorts', () => {
  it("finds every port a desktop browser or its child listens on, and no one else's", () => {
    const chrome = '/opt/google/chrome/chrome'
    const proc = fakeProc(
      { '501': 40_123, '502': 9222, '503': 3000 },
      {
        100: { exe: chrome, title: `${chrome} --user-data-dir=/p`, ppid: 1, fds: { '30': 'socket:[501]' } },
        140: { exe: chrome, title: `${chrome} --type=utility`, ppid: 100, fds: { '31': 'socket:[502]' } },
        200: { exe: '/usr/bin/python3', title: 'python3 -m http.server', ppid: 1, fds: { '3': 'socket:[503]' } }
      }
    )
    expect(browserPorts(proc, new Set([100]))).toEqual(new Map([[100, [40_123, 9222]]]))
  })
})

describe('DevtoolsEndpoints (computer-use.md §5.8)', () => {
  // Browser 100 on main; its port file names port 40123 and was written at `written`.
  const CMDLINE = '/usr/lib/google/chrome/chrome --user-data-dir=/data/browser/main --remote-debugging-port=0'

  function setup(
    options: { started?: number; written?: number; version?: string; selfTest?: SelfTestOutcome; ports?: number[] } = {}
  ) {
    const state = {
      pid: 100 as number | undefined,
      started: options.started ?? 1_000_000,
      written: options.written ?? 1_000_250,
      file: `40123\n${PATH}`,
      version: options.version ?? PATH,
      selfTest: options.selfTest ?? ('refused' as SelfTestOutcome),
      cmdline: CMDLINE,
      proxyPort: undefined as number | undefined,
      active: true,
      now: 0,
      changes: 0,
      tests: 0,
      lines: [] as string[]
    }
    // Browser 100's sockets, one per port, for the scan `doctor` reads.
    const base = fakeProc(Object.fromEntries((options.ports ?? []).map((port, i) => [`${500 + i}`, port])), {
      100: {
        exe: '/usr/lib/google/chrome/chrome',
        title: CMDLINE,
        ppid: 1,
        fds: Object.fromEntries((options.ports ?? []).map((_, i) => [`${30 + i}`, `socket:[${500 + i}]`]))
      }
    })
    const proc = {
      ...base,
      read: (path: string) => {
        if (path === '/proc/stat') return 'btime 0'
        const [, pid, file] = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(path) ?? []
        if (Number(pid) === state.pid && file === 'stat')
          return `${pid} (chrome) S 1 ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${state.started / 10}`
        if (Number(pid) === state.pid && file === 'cmdline') return `${state.cmdline}\0`
        if (pid) throw new Error(`ENOENT ${path}`)
        return base.read(path)
      }
    }
    const endpoints = new DevtoolsEndpoints({
      desktops: () => [{ desktop: 'main', profile: '/data/browser/main' }],
      active: () => state.active,
      proxyPort: () => state.proxyPort,
      log: (line) => state.lines.push(line),
      onChange: () => void state.changes++,
      proc,
      files: { mtimeMs: () => state.written, read: () => state.file },
      owner: () => state.pid,
      versionPath: async () => state.version,
      selfTest: async () => {
        state.tests++
        return state.selfTest
      },
      now: () => state.now
    })
    return { state, endpoints }
  }

  it('reports a desktop only once its file, /json/version and the self-test agree', async () => {
    const { state, endpoints } = setup()
    await endpoints.poll()
    expect(endpoints.verified()).toEqual(['main'])
    expect(endpoints.endpoint('main')).toEqual({ port: 40_123, path: PATH })
    expect(state.changes).toBe(1)
    expect(state.lines.join('\n')).not.toContain(UUID)
    await endpoints.poll()
    expect(state.tests).toBe(1)
  })

  it('refuses a stale file and a file naming another browser, and calls it not found after a while', async () => {
    const stale = setup({ written: 999_000 })
    await stale.endpoints.poll()
    expect(stale.endpoints.verified()).toEqual([])
    expect(stale.endpoints.report()).toEqual([{ desktop: 'main', pid: 100, status: 'pending' }])
    stale.state.now = 31_000
    await stale.endpoints.poll()
    expect(stale.endpoints.report()[0]?.status).toBe('not found')
    // A file written late still counts: not found is retried.
    stale.state.written = 1_000_500
    await stale.endpoints.poll()
    expect(stale.endpoints.verified()).toEqual(['main'])

    const other = setup({ version: '/devtools/browser/00000000-0000-4000-8000-000000000009' })
    await other.endpoints.poll()
    expect(other.endpoints.verified()).toEqual([])
    expect(other.state.tests).toBe(0)
  })

  it('withholds a browser that accepted a foreign Origin until it restarts', async () => {
    const { state, endpoints } = setup({ selfTest: 'accepted' })
    await endpoints.poll()
    await endpoints.poll()
    expect(endpoints.verified()).toEqual([])
    expect(endpoints.report()[0]).toMatchObject({ status: 'self-test failed', endpoint: { port: 40_123 } })
    expect(state.tests).toBe(1)
    state.pid = 101
    state.selfTest = 'refused'
    await endpoints.poll()
    expect(endpoints.verified()).toEqual(['main'])
  })

  it('checks a restarted browser afresh and drops one that exits', async () => {
    const { state, endpoints } = setup()
    await endpoints.poll()
    state.pid = 200
    state.started = 2_000_000
    await endpoints.poll()
    // The file still names the old browser's start.
    expect(endpoints.verified()).toEqual([])
    state.written = 2_000_300
    await endpoints.poll()
    expect(endpoints.verified()).toEqual(['main'])
    state.pid = undefined
    await endpoints.poll()
    expect(endpoints.verified()).toEqual([])
    expect(endpoints.report()).toEqual([])
    expect(state.changes).toBe(4)
  })

  it('drops every endpoint at once when the tier goes off', async () => {
    const { state, endpoints } = setup()
    await endpoints.poll()
    state.active = false
    await endpoints.poll()
    expect(endpoints.verified()).toEqual([])
    expect(endpoints.endpoint('main')).toBeUndefined()
  })
  it('retries a self-test that got no answer, and never fails a browser for it', async () => {
    const { state, endpoints } = setup({ selfTest: 'error' })
    await endpoints.poll()
    expect(endpoints.verified()).toEqual([])
    expect(endpoints.report()).toEqual([{ desktop: 'main', pid: 100, status: 'pending' }])
    expect(state.lines).toEqual([])
    state.selfTest = 'refused'
    await endpoints.poll()
    expect(endpoints.verified()).toEqual(['main'])
    expect(state.tests).toBe(2)
  })

  it('names a browser started before the tier turned on, which keeps no endpoint until its next start', async () => {
    const { state, endpoints } = setup()
    state.cmdline = '/usr/lib/google/chrome/chrome --user-data-dir=/data/browser/main'
    await endpoints.poll()
    expect(endpoints.report()).toEqual([{ desktop: 'main', pid: 100, status: 'before the tier' }])
    expect(state.tests).toBe(0)
  })

  it('refuses a browser whose command line carries --remote-allow-origins or lacks the forwarder', async () => {
    const origins = setup()
    origins.state.cmdline = `${CMDLINE} --remote-allow-origins=*`
    await origins.endpoints.poll()
    expect(origins.endpoints.report()[0]?.status).toBe('refused switches')
    expect(origins.endpoints.verified()).toEqual([])
    expect(origins.state.tests).toBe(0)

    const unproxied = setup()
    unproxied.state.proxyPort = 41_000
    await unproxied.endpoints.poll()
    expect(unproxied.endpoints.report()[0]?.status).toBe('refused switches')
    unproxied.state.pid = 101
    unproxied.state.cmdline = `${CMDLINE} --proxy-server=http://127.0.0.1:41000`
    await unproxied.endpoints.poll()
    expect(unproxied.endpoints.verified()).toEqual(['main'])
  })

  it('names the endpoint a browser keeps after the tier goes off, apart from a port it opened otherwise', async () => {
    const { state, endpoints } = setup({ ports: [40_123, 9222] })
    await endpoints.poll()
    expect(endpoints.report()[0]).toMatchObject({ status: 'ok', extra: [9222] })
    state.active = false
    await endpoints.poll()
    expect(endpoints.report()).toEqual([{ desktop: 'main', pid: 100, status: 'pending', extra: [9222], kept: 40_123 }])
  })
})

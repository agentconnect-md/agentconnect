import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withCallContext, type AuditRecord } from '../audit.js'
import { CommandLine } from '../command-line.js'
import { Computer, type ToolOutput } from '../computer.js'
import { startHttpServer, type RunningHttpServer } from '../http-server.js'
import { FakeDriver, testConfig } from '../testing.js'
import { createComputerMcpServer } from '../tools.js'
import { chromeAuditArgs } from './chrome-contract.js'
import type { DevtoolsTarget } from './chrome-pages.js'
import { ChromeTools, type ChromeCall } from './chrome-tools.js'
import type { DevtoolsEndpoint } from './devtools-endpoint.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-chrome-devtools-mcp.mjs', import.meta.url))
const BROWSER = '/devtools/browser/0b2c3d4e-0000-4000-8000-000000000001'
const RESTARTED = '/devtools/browser/0b2c3d4e-0000-4000-8000-000000000002'
const TARGET_A = 'A1B2C3D4E5F60718293A4B5C6D7E8F90'
const TARGET_B = 'B1B2C3D4E5F60718293A4B5C6D7E8F90'

interface FakeState {
  pages: { url: string; title: string }[]
  targets: DevtoolsTarget[]
  hang?: string[]
  screenshot?: 'file' | 'oversized'
  leak?: string
  starts?: number
  startupDelayMs?: number
  navigationFailure?: boolean
}

let root: string
let stateFile: string
let tools: ChromeTools | undefined
let running: RunningHttpServer | undefined
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'computer-chrome-'))
  stateFile = join(root, 'state.json')
})
afterEach(async () => {
  await tools?.stopAll('test over')
  tools = undefined
  await running?.close()
  running = undefined
  rmSync(root, { recursive: true, force: true })
})

const state = (): FakeState => JSON.parse(readFileSync(stateFile, 'utf8')) as FakeState
const setState = (patch: Partial<FakeState>): void => writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }))
interface Logged {
  pid: number
  event: string
  name?: string
  args?: Record<string, unknown>
  argv?: string[]
  env?: Record<string, string>
}
const logged = (): Logged[] => {
  try {
    return readFileSync(`${stateFile}.log`, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Logged)
  } catch {
    return []
  }
}
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const alive = (pid: number | null): boolean => {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const textOf = (output: ToolOutput): string => output.content.map((block) => block.text ?? '').join('\n')
const errorOf = (output: ToolOutput) => JSON.parse(textOf(output)) as { error: string; reason?: string }

function start(overrides: Partial<ConstructorParameters<typeof ChromeTools>[0]> = {}) {
  writeFileSync(
    stateFile,
    JSON.stringify({
      pages: [
        { url: 'http://127.0.0.1:5173/', title: 'Dev server' },
        { url: 'https://example.test/docs', title: 'Docs' }
      ],
      targets: [
        { id: TARGET_A, type: 'page', url: 'http://127.0.0.1:5173/', title: 'Dev server' },
        { id: TARGET_B, type: 'page', url: 'https://example.test/docs', title: 'Docs' },
        { id: 'C0FFEE00C0FFEE00C0FFEE00C0FFEE00', type: 'service_worker', url: 'https://example.test/sw.js', title: '' }
      ]
    } satisfies FakeState)
  )
  const endpoints = new Map<string, DevtoolsEndpoint | undefined>([['main', { port: 9222, path: BROWSER }]])
  const records: AuditRecord[] = []
  let idleMs = 60_000
  tools = new ChromeTools({
    endpoint: (desktop) => endpoints.get(desktop),
    idleMs: () => idleMs,
    maxImageDimension: () => 1280,
    audit: (record) => records.push(record),
    log: () => undefined,
    command: [process.execPath, FAKE, stateFile],
    targets: async () => state().targets,
    watchMs: 25,
    ...overrides
  })
  const call = (tool: string, args: Record<string, unknown> = {}, desktop = 'main') =>
    tools!.call({ desktop, client: 'agent/session', tool, args })
  const ids = async (): Promise<string[]> =>
    [...textOf(await call('chrome_list_pages')).matchAll(/^(p[0-9a-f]{10}): /gm)].map((match) => match[1]!)
  return { endpoints, records, call, ids, setIdle: (ms: number) => (idleMs = ms), tools }
}

describe.skipIf(process.platform === 'win32')('the Chrome DevTools MCP child (computer-use.md §5.8)', () => {
  it('starts one child per desktop on the checked endpoint, with the flags and environment of §5.8', async () => {
    const { call } = start()
    await call('chrome_list_pages')
    const launch = logged().find((entry) => entry.event === 'start') as Required<Logged>
    expect(launch!.argv.slice(0, 2)).toEqual(['--wsEndpoint', `ws://127.0.0.1:9222${BROWSER}`])
    expect(launch!.argv).toEqual(
      expect.arrayContaining([
        '--no-usage-statistics',
        '--no-performance-crux',
        '--no-category-emulation',
        '--no-category-performance',
        '--no-category-network',
        '--no-category-memory',
        '--no-file-navigations',
        '--no-javascript-evaluation'
      ])
    )
    expect(launch!.argv.join(' ')).toContain('--screenshotFormat jpeg --screenshotMaxWidth 1280')
    expect(launch!.argv).not.toContain('--browserUrl')
    expect(launch!.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS).toBe('1')
    expect(launch!.env.CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY).toBe('1')
    // An empty TMPDIR and home of its own, which is also its only filesystem root.
    expect(launch!.env.TMPDIR).toBe(launch!.env.HOME)
    expect(launch!.argv.at(-1)).toBe(launch!.env.TMPDIR)
  })

  it('lists pages under opaque ids, never the child’s numbers or a target id', async () => {
    const { call, ids } = start()
    const listed = await call('chrome_list_pages')
    const text = textOf(listed)
    expect(text).toMatch(/^## Pages\np[0-9a-f]{10}: Dev server \(http:\/\/127\.0\.0\.1:5173\/\)$/m)
    expect(text).not.toMatch(/^\d+: /m)
    expect(text).not.toContain('[selected]')
    expect(text).not.toContain(TARGET_A)
    const [dev] = await ids()
    await call('chrome_take_snapshot', { pageId: dev })
    expect(logged().find((entry) => entry.name === 'take_snapshot')?.args).toEqual({ pageId: 1 })
  })

  it('keeps page ids across a child restart, which numbers its pages anew', async () => {
    const { call, ids, setIdle, tools } = start()
    const [dev, docs] = await ids()
    setIdle(50)
    await until(() => tools.running().length === 0)
    setIdle(60_000)
    const snapshot = await call('chrome_take_snapshot', { pageId: docs })
    expect(textOf(snapshot)).toContain('RootWebArea "Docs"')
    // The second child numbers from 11: the id was bound again through its own list.
    expect(
      logged()
        .filter((entry) => entry.name === 'take_snapshot')
        .at(-1)?.args
    ).toEqual({ pageId: 12 })
    expect(await ids()).toEqual([dev, docs])
  })

  it('matches URLs with parentheses across child restarts regardless of the order Chrome lists targets', async () => {
    const { call, ids, setIdle, tools } = start()
    const pages = [
      { url: 'https://example.test/wiki/Mercury_(planet)', title: 'Planet' },
      { url: 'https://example.test/wiki/Mercury_(element)', title: 'Element' }
    ]
    const targets = pages.map((page, index) => ({ ...page, id: [TARGET_A, TARGET_B][index]!, type: 'page' }))
    setState({ pages, targets: [...targets].reverse() })
    const [planet] = await ids()
    setIdle(50)
    await until(() => tools.running().length === 0)
    setIdle(60_000)
    setState({ targets })
    expect(textOf(await call('chrome_take_snapshot', { pageId: planet }))).toContain('RootWebArea "Planet"')
  })

  it('does not issue ids for indistinguishable tabs', async () => {
    const { call } = start()
    const page = state().pages[0]!
    setState({
      pages: [page, page],
      targets: [TARGET_A, TARGET_B].map((id) => ({ ...page, id, type: 'page' }))
    })
    const output = textOf(await call('chrome_list_pages'))
    expect(output).toContain('Some tabs could not be identified')
    expect(output).not.toMatch(/^p[0-9a-f]{10}: /m)
  })

  it('preserves issued page ids after a failed target listing', async () => {
    const { call, ids } = start()
    const [dev, docs] = await ids()
    const { targets } = state()
    setState({ targets: [] })
    expect(textOf(await call('chrome_list_pages'))).toContain(dev)
    setState({ targets })
    expect(await ids()).toEqual([dev, docs])
  })

  it('keeps page ids across a browser restart by the restored tabs’ addresses', async () => {
    // A browser that just started lists no page targets at first (measured), so the desktop asks again.
    let fresh = false
    const { call, endpoints, ids, tools } = start({
      targets: async () => {
        if (!fresh) return state().targets
        fresh = false
        return []
      }
    })
    const [dev, docs] = await ids()
    const first = tools.running()[0]!.pid
    endpoints.set('main', { port: 9333, path: RESTARTED })
    fresh = true
    setState({
      targets: [
        { id: 'D1D2D3D4E5F60718293A4B5C6D7E8F90', type: 'page', url: 'https://example.test/docs', title: 'Docs' },
        { id: 'E1E2E3E4E5F60718293A4B5C6D7E8F90', type: 'page', url: 'http://127.0.0.1:5173/', title: 'Dev server' }
      ],
      pages: [
        { url: 'https://example.test/docs', title: 'Docs' },
        { url: 'http://127.0.0.1:5173/', title: 'Dev server' }
      ]
    })
    // The child of the old endpoint is killed, not left failing every call.
    await until(() => !alive(first))
    expect(textOf(await call('chrome_take_snapshot', { pageId: dev }))).toContain('Dev server')
    expect(await ids()).toEqual([docs, dev])
    const launches = logged().filter((entry) => entry.event === 'start')
    expect(launches.at(-1)!.argv![1]).toBe(`ws://127.0.0.1:9333${RESTARTED}`)
  })

  it('stops the child after leaseIdleSeconds without a call, when its browser exits, and when its desktop stops', async () => {
    const { call, endpoints, setIdle, tools } = start()
    await call('chrome_list_pages')
    let pid = tools.running()[0]!.pid
    setIdle(50)
    await until(() => tools.running().length === 0 && !alive(pid))

    setIdle(60_000)
    await call('chrome_list_pages')
    pid = tools.running()[0]!.pid
    endpoints.set('main', undefined)
    await until(() => tools.running().length === 0 && !alive(pid))
    expect(errorOf(await call('chrome_list_pages'))).toMatchObject({
      error: 'unavailable',
      reason: 'browser_not_running'
    })

    endpoints.set('main', { port: 9222, path: BROWSER })
    const [dev] = [...textOf(await call('chrome_list_pages')).matchAll(/^(p[0-9a-f]{10}): /gm)].map((m) => m[1]!)
    pid = tools.running()[0]!.pid
    await tools.stop('main', 'its desktop stopped')
    expect(tools.running()).toEqual([])
    await until(() => !alive(pid))
    // The desktop's page ids went with it.
    expect(errorOf(await call('chrome_take_snapshot', { pageId: dev }))).toMatchObject({ error: 'invalid_argument' })
  })

  it('races a call against its browser’s exit, and kills the child that would hang', async () => {
    const { call, endpoints, ids, tools } = start()
    const [dev] = await ids()
    setState({ hang: ['take_snapshot'] })
    const pid = tools.running()[0]!.pid
    const pending = call('chrome_take_snapshot', { pageId: dev })
    await until(() => logged().some((entry) => entry.name === 'take_snapshot'))
    endpoints.set('main', undefined)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(errorOf(result)).toMatchObject({ error: 'unavailable', reason: 'browser_exited' })
    await until(() => !alive(pid))
  })

  it('reaps a child that is still starting when its desktop stops', async () => {
    const { call, tools } = start()
    setState({ startupDelayMs: 200 })
    const result = call('chrome_list_pages')
    await until(() => logged().some((entry) => entry.event === 'start'))
    const pid = logged().find((entry) => entry.event === 'start')!.pid
    await tools.stop('main', 'its desktop stopped')
    expect(tools.running()).toEqual([])
    await until(() => !alive(pid))
    expect(errorOf(await result)).toMatchObject({ error: 'unavailable', reason: 'browser_exited' })
  })

  it('kills a child that does not answer by the deadline', async () => {
    const { call, ids, tools } = start({ deadlineMs: 300 })
    const [dev] = await ids()
    setState({ hang: ['wait_for'] })
    const pid = tools.running()[0]!.pid
    const result = await call('chrome_wait_for', { pageId: dev, text: ['never'] })
    expect(errorOf(result)).toMatchObject({ error: 'unavailable', reason: 'timeout' })
    await until(() => !alive(pid))
  })

  it('strips target ids, the browser id and ws:// URLs from results', async () => {
    const { call, ids } = start()
    const [dev] = await ids()
    setState({ leak: TARGET_A.toLowerCase() })
    const text = textOf(await call('chrome_take_snapshot', { pageId: dev }))
    expect(text.toLowerCase()).not.toContain(TARGET_A.toLowerCase())
    expect(text).not.toContain('ws://')
    expect(text).toContain('[redacted]')
  })

  it('refuses tools outside the contract and the ones that act, before any child starts', async () => {
    const { call, tools } = start()
    for (const tool of ['chrome_lighthouse_audit', 'chrome_get_css_styles', 'chrome_set_logpoints', 'chrome_click'])
      expect(errorOf(await call(tool))).toMatchObject({ error: 'denied' })
    expect(tools.running()).toEqual([])
    expect(logged()).toEqual([])
  })

  it('reads, attaches and deletes a screenshot the child saved to a file', async () => {
    const { call, ids } = start()
    const [dev] = await ids()
    setState({ screenshot: 'file' })
    const result = await call('chrome_take_screenshot', { pageId: dev })
    const image = result.content.find((block) => block.type === 'image')
    expect(image).toMatchObject({ mimeType: 'image/jpeg', data: Buffer.from('big jpeg').toString('base64') })
    expect(textOf(result)).not.toContain('Saved screenshot')
    // The file and the directory the child made for it are gone; nothing else is left in its root.
    const dir = logged().find((entry) => entry.event === 'start')!.env!.TMPDIR!
    expect(readdirSync(dir)).toEqual([])
  })

  it('returns an audited tool error and cleans up a screenshot too large to deliver', async () => {
    const { call, ids, records } = start()
    const [dev] = await ids()
    setState({ screenshot: 'oversized' })
    const result = await call('chrome_take_screenshot', { pageId: dev })
    expect(errorOf(result)).toMatchObject({ error: 'unavailable', reason: 'result_too_large' })
    expect(result.isError).toBe(true)
    expect(records.at(-1)).toMatchObject({ outcome: 'error', code: 'unavailable' })
    const dir = logged().find((entry) => entry.event === 'start')!.env!.TMPDIR!
    expect(readdirSync(dir)).toEqual([])
  })

  it('audits one entry per call, and stores a session’s screenshot as computer_screenshot’s', async () => {
    const stashed: string[] = []
    const { call, ids, records } = start({
      screenshots: (output) => {
        stashed.push(output.content.find((block) => block.type === 'image')!.mimeType!)
        return { output, ref: 'sha256:00' }
      }
    })
    const [dev] = await ids()
    await call('chrome_take_screenshot', { pageId: dev }, 'main')
    expect(records.map((record) => record.tool)).toEqual(['chrome_list_pages', 'chrome_take_screenshot'])
    expect(records.at(-1)).toMatchObject({
      client: 'agent/session',
      args: { pageId: dev },
      outcome: 'ok',
      screenshotRef: 'sha256:00'
    })
    expect(records.at(-1)).not.toHaveProperty('desktop')
    expect(stashed).toEqual(['image/jpeg'])
    expect(chromeAuditArgs({ url: 'https://example.test/a/b?token=secret', filePath: '/etc/passwd' })).toEqual({
      url: 'https://example.test'
    })
  })

  function actionSetup(options: Partial<ConstructorParameters<typeof ChromeTools>[0]> = {}) {
    const activated: string[] = []
    const context = start({
      activate: async (_endpoint, target, fence) => {
        fence()
        activated.push(target)
      },
      ...options
    })
    let launches = 0
    const computer = new Computer({
      driver: new FakeDriver(),
      config: testConfig({ actionScreenshot: false }),
      ...(options.now ? { now: options.now } : {}),
      launchBrowser: () => async () => {
        expect(computer.leaseActivity()?.holder).toBe('agent/session')
        launches++
        context.endpoints.set('main', { port: 9222, path: BROWSER })
        return 'launched'
      }
    })
    const action: ChromeCall['action'] = {
      target: async () => ({ computer, desktop: 'main' }),
      enabled: () => true
    }
    const act = (tool: string, args: Record<string, unknown>, commandLine?: ChromeCall['commandLine']) =>
      context.tools.call({
        desktop: 'main',
        client: 'agent/session',
        tool,
        args,
        action,
        ...(commandLine ? { commandLine } : {})
      })
    return { ...context, activated, computer, act, launches: () => launches }
  }

  it('opens Chrome under the lease and returns the opened tab’s opaque id', async () => {
    const { act, launches, endpoints } = actionSetup()
    endpoints.delete('main')
    const result = await act('chrome_new_page', { url: 'https://example.test/new', background: true })
    expect(launches()).toBe(1)
    expect(textOf(result)).toMatch(/^p[0-9a-f]{10}: New tab \(https:\/\/example\.test\/new\)$/m)
    expect(logged().find((entry) => entry.name === 'new_page')?.args?.background).toBe(false)
  })

  it('uses the same lease and human idle gate as desktop input, then activates the exact page', async () => {
    let now = 10_000
    const { act, ids, computer, activated, tools } = actionSetup({ now: () => now })
    const [dev] = await ids()
    computer.acquire('other')
    expect(errorOf(await act('chrome_click', { pageId: dev, uid: '1_1' })).error).toBe('computer_busy')
    computer.release('other')
    computer.noteHumanInput()
    expect(errorOf(await act('chrome_click', { pageId: dev, uid: '1_1' })).error).toBe('human_active')
    now += 60_000
    computer.pause('owner paused')
    expect(errorOf(await act('chrome_click', { pageId: dev, uid: '1_1' })).error).toBe('human_in_control')
    expect(activated).toEqual([])
    expect(logged().filter(({ name }) => name === 'click')).toEqual([])
    computer.resume()
    expect((await act('chrome_click', { pageId: dev, uid: '1_1' })).isError).toBeUndefined()
    expect(activated).toEqual([TARGET_A])
    expect(computer.leaseActivity()?.holder).toBe('agent/session')
    computer.noteHumanInput()
    const pid = tools.running()[0]!.pid
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(tools.running()[0]?.pid).toBe(pid)
  })

  it('returns uncertain with a desktop screenshot and never replays an interrupted action', async () => {
    const { act, ids, records, tools } = actionSetup({ deadlineMs: 300 })
    const [dev] = await ids()
    setState({ hang: ['click'] })
    const result = await act('chrome_click', { pageId: dev, uid: '1_1' })
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ error: 'uncertain' })
    expect(result.content.some(({ type }) => type === 'image')).toBe(true)
    expect(records.at(-1)).toMatchObject({ tool: 'chrome_click', outcome: 'error', code: 'uncertain' })
    expect(logged().filter(({ name }) => name === 'click')).toHaveLength(1)
    expect(tools.running()).toEqual([])
  })

  it('converts a navigation failure returned as success into an uncertain outcome', async () => {
    const { act, ids } = actionSetup()
    const [dev] = await ids()
    setState({ navigationFailure: true })
    const result = await act('chrome_navigate_page', { pageId: dev, type: 'url', url: 'https://example.test/fail' })
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({ error: 'uncertain' })
    expect(result.content.some(({ type }) => type === 'image')).toBe(true)
  })

  it('checks script approval and file roots, and closes the child when the control lease ends', async () => {
    const { act, ids, computer, tools } = actionSetup({
      childAccess: async () => ({ scripts: true, fileRoots: [root] })
    })
    const [dev] = await ids()
    const commandLine: NonNullable<ChromeCall['commandLine']> = {
      runner: new CommandLine({ dataDir: join(root, 'daemon'), home: root }),
      shell: () => 'ask',
      files: () => 'read',
      roots: () => [root]
    }
    const script = { pageId: dev, function: '() => document.title' }
    const firstChild = tools.running()[0]!.pid
    expect(errorOf(await act('chrome_evaluate_script', script)).error).toBe('denied')
    expect(errorOf(await act('chrome_evaluate_script', script, commandLine)).error).toBe('approval_required')
    expect(
      errorOf(
        await act('chrome_upload_file', { pageId: dev, uid: '1_1', filePaths: ['/outside/example.txt'] }, commandLine)
      ).error
    ).toBe('denied')
    const approved = await withCallContext({ approval: 'allowed' }, () =>
      act('chrome_evaluate_script', script, commandLine)
    )
    expect(approved.isError).toBeUndefined()
    expect(logged().filter(({ name }) => name === 'evaluate_script')).toHaveLength(1)
    expect(tools.running()[0]!.pid).toBe(firstChild)
    expect(
      logged()
        .filter(({ event }) => event === 'start')
        .at(-1)?.argv
    ).not.toContain('--no-javascript-evaluation')
    const file = join(root, 'example.txt')
    writeFileSync(file, 'example')
    const upload = await act('chrome_upload_file', { pageId: dev, uid: '1_1', filePaths: [file] }, commandLine)
    expect(upload.isError).toBeUndefined()
    expect(logged().find(({ name }) => name === 'upload_file')?.args?.filePaths).toEqual([file])
    const { pid } = tools.running()[0]!
    computer.release('agent/session')
    await until(() => !alive(pid))
    expect(tools.running()).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('the chrome_* tools on /mcp', () => {
  async function serve(refusal: () => string | undefined) {
    const { tools, endpoints } = start()
    const config = testConfig({ actionScreenshot: false })
    const computer = new Computer({ driver: new FakeDriver(), config })
    running = await startHttpServer({
      host: config.host,
      port: 0,
      computer,
      authenticate: () => ({ client: 'local', viewOnly: false }),
      createMcpServer: ({ client }) =>
        createComputerMcpServer({
          computer,
          client,
          browser: { tools, desktop: () => 'main', available: () => endpoints.has('main'), refusal }
        }),
      log: () => undefined
    })
    const client = new Client({ name: 'test', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))
    return { client, endpoints }
  }

  it('registers exactly the six reading tools, and nothing of the child’s outside the contract', async () => {
    const { client } = await serve(() => undefined)
    const names = (await client.listTools()).tools.map((tool) => tool.name).filter((name) => name.startsWith('chrome_'))
    expect(names.sort()).toEqual(
      [
        'chrome_get_console_message',
        'chrome_list_console_messages',
        'chrome_list_pages',
        'chrome_take_screenshot',
        'chrome_take_snapshot',
        'chrome_wait_for'
      ].sort()
    )
    await expect(client.callTool({ name: 'chrome_get_css_styles', arguments: {} })).rejects.toThrow(/not found/)
    await expect(client.callTool({ name: 'chrome_click', arguments: {} })).rejects.toThrow(/not found/)
    const listed = (await client.callTool({ name: 'chrome_list_pages', arguments: {} })) as ToolOutput
    expect(textOf(listed)).toMatch(/^p[0-9a-f]{10}: Dev server/m)
    await client.close()
  })

  it('refuses a call once the policy no longer allows the tier', async () => {
    const policy: { refusal?: string } = {}
    const { client } = await serve(() => policy.refusal)
    policy.refusal = "this computer's policy does not allow the browser tier"
    const result = (await client.callTool({ name: 'chrome_list_pages', arguments: {} })) as ToolOutput
    expect(errorOf(result)).toMatchObject({ error: 'denied' })
    await client.close()
  })

  it('omits tools from discovery when the browser exits and returns a retryable error to a call from the earlier list', async () => {
    const { client, endpoints } = await serve(() => undefined)
    expect((await client.listTools()).tools.some((tool) => tool.name === 'chrome_list_pages')).toBe(true)
    endpoints.delete('main')
    expect((await client.listTools()).tools.some((tool) => tool.name === 'chrome_list_pages')).toBe(false)
    const result = (await client.callTool({ name: 'chrome_list_pages', arguments: {} })) as ToolOutput
    expect(errorOf(result)).toMatchObject({ error: 'unavailable', reason: 'browser_not_running' })
    await client.close()
  })
})

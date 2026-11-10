import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ComputerFormDiscovery, ComputerFormFillResult } from '@agentconnect.md/protocol/computer-form-fill'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFixtures, type Fixtures } from './form-fill/fixtures.js'
import { startStubCp, type StubCp } from './form-fill/stub-cp.js'

// The published image end to end (computer-form-fill-and-vault.md §8, §11 S1): its own Chromium, extension and daemon.
const image = process.env.COMPUTER_IMAGE
const HOST = 'host.docker.internal'
const name = `ac-form-fill-e2e-${process.pid}`

// Recognizable values that must reach the websites and nothing else (§11's canary oracle).
const CANARY = {
  username: 'canary-user-71c3',
  password: 'canary-pass-9e4d',
  name: 'Zoë 李雷 🚀 canary-name-55aa',
  reactA: 'canary-react-a-0f12@example.test',
  reactPasswordA: 'canary-react-pass-a-3b7e',
  reactB: 'canary-react-b-8d21@example.test',
  reactPasswordB: 'canary-react-pass-b-6c90',
  vueFirst: 'canary-vue-first-2a44',
  frameEmail: 'canary-frame-c9d8@example.test',
  framePassword: 'canary-frame-pass-1f0b',
  slow: 'canary-slow-77e1'
}

let cp: StubCp
let fixtures: Fixtures
let base: string
const results: string[] = []

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' })
const logs = () =>
  spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stdout +
  spawnSync('docker', ['logs', name], { encoding: 'utf8' }).stderr

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined> | T | undefined
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await Promise.resolve()
      .then(probe)
      .catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline)
      throw new Error(
        `timed out waiting for ${what}\n--- last results ---\n${results.slice(-3).join('\n')}\n--- container log ---\n${logs().slice(-6000)}`
      )
    await sleep(500)
  }
}

/** One agent session on the Computer, calling the desktop's /mcp with its channel token as an agent daemon would. */
class Agent {
  readonly id = randomUUID()
  readonly session = `session-${randomUUID()}`
  private client: Client | undefined

  constructor(readonly desk: string) {}

  private async connect(): Promise<Client> {
    // Tokens live minutes; each call gets a fresh client as the agent daemon asks for a fresh token.
    await this.client?.close().catch(() => undefined)
    const client = new Client({ name: `agent-${this.desk}`, version: '0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${cp.token(this.id, this.session)}` } }
      })
    )
    this.client = client
    return client
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const client = await this.connect()
    const result = (await client.callTool({ name: tool, arguments: args }, { timeout: 90_000 })) as {
      content: { type: string; text?: string }[]
      isError?: boolean
    }
    const text = result.content.map((block) => block.text ?? '').join('\n')
    results.push(text)
    return { text, isError: result.isError === true }
  }

  async json<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const { text } = await this.call(tool, args)
    return JSON.parse(text) as T
  }

  /** Opens a page in this agent's own desktop browser the way an agent does: address bar, type, Return. */
  async open(path: string, origin = fixtures.origins[0]): Promise<void> {
    const url = `${origin}${path}${path.includes('?') ? '&' : '?'}desk=${this.desk}`
    // The page before may still answer discovery while the new one loads: wait for another document.
    const before = await this.discover().catch(() => undefined)
    const previous = new Set((before?.forms ?? []).map((form) => form.documentId))
    await this.call('computer_key', { keys: ['escape'] })
    await this.call('computer_key', { keys: ['ctrl', 'l'] })
    await this.call('computer_type', { text: url })
    await this.call('computer_key', { keys: ['return'] })
    const title = new URL(url).pathname
    await until(`${this.desk} to load ${title}`, 30_000, async () => {
      const discovery = await this.discover()
      const fresh = discovery.forms.length > 0 && discovery.forms.every((form) => !previous.has(form.documentId))
      return discovery.status !== 'unsupported' && discovery.tab && (fresh || path.startsWith('/done'))
        ? true
        : undefined
    })
  }

  discover(form?: string): Promise<ComputerFormDiscovery> {
    return this.json<ComputerFormDiscovery>('computer_form_discover', { v: 1, ...(form ? { form } : {}) })
  }

  async fill(
    discovery: ComputerFormDiscovery,
    values: Record<string, string | boolean>
  ): Promise<ComputerFormFillResult> {
    const target = discovery.target!
    const form = discovery.forms.find((candidate) => candidate.id === target.formId)!
    const byName = (fieldName: string) => form.fields.find((field) => field.name === fieldName)!.id
    return this.json<ComputerFormFillResult>('computer_form_fill', {
      v: 1,
      requestId: randomUUID(),
      target,
      values: Object.entries(values).map(([field, value]) =>
        typeof value === 'boolean' ? { field: byName(field), checked: value } : { field: byName(field), value }
      )
    })
  }

  /** Starts this agent's desktop and browser, and waits for the extension there to connect. */
  async start(): Promise<void> {
    await this.call('computer_screenshot')
    await this.call('computer_launch', { app: 'chromium' })
    // A new browser shows its new-tab page, which is not a website: the extension answering at all is enough here.
    await until(`the extension on ${this.desk}'s desktop`, 90_000, async () =>
      /not connected/.test((await this.discover()).reason ?? '') ? undefined : true
    )
  }
}

const reported = (page: string, desk: string) =>
  fixtures.reports.filter((report) => report.page === page && report.desk === desk).map((report) => report.values)
const lastReport = (page: string, desk: string) => reported(page, desk).at(-1)

describe.skipIf(!image)('form fill in the computer image (computer-form-fill-and-vault.md §11 S1)', () => {
  const a = new Agent('a')
  const b = new Agent('b')

  beforeAll(async () => {
    cp = await startStubCp(HOST)
    fixtures = await startFixtures(HOST)
    spawnSync('docker', ['rm', '-f', name])
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--shm-size=1g',
      '--add-host',
      `${HOST}:host-gateway`,
      '-p',
      '127.0.0.1::7681',
      '-e',
      `AGENTCONNECT_CP_URL=${cp.url}`,
      '-e',
      `AGENTCONNECT_REGISTER_TOKEN=${cp.registerToken}`,
      image!
    )
    base = `http://${docker('port', name, '7681/tcp').trim().split('\n')[0]}`
    await until('the desktop to authenticate with the stub Control Plane', 120_000, () =>
      cp.authenticated() ? true : undefined
    )
    await until('the main desktop extension', 120_000, () =>
      /form fill: extension .* connected on desktop main/.test(logs()) ? true : undefined
    )
    await Promise.all([a.start(), b.start()])
  }, 360_000)

  afterAll(async () => {
    if (process.env.COMPUTER_E2E_KEEP !== '1') spawnSync('docker', ['rm', '-f', name])
    await cp?.close()
    await fixtures?.close()
  })

  it('gives each agent a desktop of its own, and each fill lands in that agent’s browser only', async () => {
    await Promise.all([a.open('/react.html'), b.open('/react.html')])
    const [discoveredA, discoveredB] = await Promise.all([a.discover(), b.discover()])
    expect(discoveredA.status).toBe('found')
    expect(discoveredA.forms[0]!.kind).toBe('login')
    const [filledA, filledB] = await Promise.all([
      a.fill(discoveredA, { email: CANARY.reactA, password: CANARY.reactPasswordA, plan: 'pro' }),
      b.fill(discoveredB, { email: CANARY.reactB, password: CANARY.reactPasswordB })
    ])
    expect(filledA.status).toBe('filled')
    expect(filledB.status).toBe('filled')
    await until('React state reports', 10_000, () =>
      lastReport('react', 'a')?.plan === 'pro' && lastReport('react', 'b')?.password ? true : undefined
    )
    // The website's own React state took the values: controlled inputs and the select.
    expect(lastReport('react', 'a')).toEqual({ email: CANARY.reactA, password: CANARY.reactPasswordA, plan: 'pro' })
    expect(lastReport('react', 'b')).toEqual({ email: CANARY.reactB, password: CANARY.reactPasswordB, plan: 'free' })
    expect(JSON.stringify(reported('react', 'a'))).not.toContain(CANARY.reactB)
    expect(JSON.stringify(reported('react', 'b'))).not.toContain(CANARY.reactA)
    // Fill only: nothing was submitted.
    expect(fixtures.reports.some((report) => report.values.submitted)).toBe(false)
  })

  it('describes a form without its values, and fills text, Unicode, a select and a checkbox', async () => {
    await a.open('/vanilla.html')
    const discovery = await a.discover()
    expect(discovery.status).toBe('found')
    expect(discovery.tab?.title).toBe('Create account')
    expect(discovery.forms[0]!.fields.map((field) => [field.name, field.purpose, field.secret])).toEqual([
      ['username', 'username', false],
      ['password', 'current-password', true],
      ['full_name', 'name', false],
      ['country', 'country', false],
      ['terms', 'unknown', false]
    ])
    const result = await a.fill(discovery, {
      username: CANARY.username,
      password: CANARY.password,
      full_name: CANARY.name,
      country: 'Japan',
      terms: true
    })
    expect(result.status).toBe('filled')
    expect(result.navigated).toBe(false)
    await until('the plain form report', 10_000, () => (lastReport('vanilla', 'a')?.terms === true ? true : undefined))
    expect(lastReport('vanilla', 'a')).toEqual({
      username: CANARY.username,
      password: CANARY.password,
      full_name: CANARY.name,
      country: 'JP',
      terms: true
    })
  })

  it('reports a partial fill field by field', async () => {
    await a.open('/vanilla.html')
    const discovery = await a.discover()
    const result = await a.fill(discovery, { username: 'second-user', country: 'Atlantis' })
    expect(result.status).toBe('partial')
    expect(result.fields.map((field) => field.status)).toEqual(['filled', 'invalid_value'])
  })

  it('fills a Vue form through v-model', async () => {
    await b.open('/vue.html')
    const discovery = await b.discover()
    expect(discovery.forms[0]!.kind).toBe('personal_info')
    expect(
      (await b.fill(discovery, { first_name: CANARY.vueFirst, last_name: 'Lovelace', country: 'DE' })).status
    ).toBe('filled')
    await until('the Vue report', 10_000, () => (lastReport('vue', 'b')?.country === 'DE' ? true : undefined))
    expect(lastReport('vue', 'b')).toEqual({ first: CANARY.vueFirst, last: 'Lovelace', country: 'DE' })
  })

  it('finds and fills a sign-in form in a cross-origin frame, bound to the frame origin', async () => {
    await a.open('/framed.html')
    const discovery = await a.discover()
    expect(discovery.status).toBe('found')
    expect(discovery.target).toMatchObject({ topOrigin: fixtures.origins[0], frameOrigin: fixtures.origins[1] })
    expect(discovery.target!.frameId).toBeGreaterThan(0)
    expect((await a.fill(discovery, { email: CANARY.frameEmail, password: CANARY.framePassword })).status).toBe(
      'filled'
    )
    await until('the frame report', 10_000, () => (lastReport('frame', 'a')?.password ? true : undefined))
    expect(lastReport('frame', 'a')).toEqual({ email: CANARY.frameEmail, password: CANARY.framePassword })
  })

  it('writes nothing to a page reloaded since discovery', async () => {
    await b.open('/vanilla.html')
    const discovery = await b.discover()
    const before = reported('vanilla', 'b').length
    await b.call('computer_key', { keys: ['f5'] })
    await until('the reload', 15_000, async () => {
      const again = await b.discover()
      return again.target && again.target.documentId !== discovery.target!.documentId ? true : undefined
    })
    const result = await b.fill(discovery, { username: 'stale-write' })
    expect(result.status).toBe('target_changed')
    expect(result.fields).toEqual([])
    await sleep(1000)
    expect(reported('vanilla', 'b')).toHaveLength(before)
  })

  it('reports a site that submits on input as navigated', async () => {
    await b.open('/auto-submit.html')
    const result = await b.fill(await b.discover(), { code: '123456' })
    expect(result.navigated).toBe(true)
  })

  it('returns uncertain when the page does not answer in time, and does not fill again', async () => {
    await a.open('/slow.html')
    const result = await a.fill(await a.discover(), { code: CANARY.slow })
    expect(result.status).toBe('uncertain')
    expect(result.reason).toMatch(/not retried/)
    await until('the slow handler to finish', 30_000, () => (reported('slow', 'a').length > 0 ? true : undefined))
    await sleep(2000)
    expect(reported('slow', 'a')).toEqual([{ code: CANARY.slow }])
  }, 90_000)

  it('reconnects after the computer restarts: the daemon reports the browser, and a fill works on the kept profile', async () => {
    const before = (logs().match(/form fill: extension .* connected on desktop main/g) ?? []).length
    docker('restart', '-t', '20', name)
    // A restarted container publishes the daemon on a new host port.
    base = `http://${docker('port', name, '7681/tcp').trim().split('\n')[0]}`
    await until('the extension to reconnect to the restarted daemon', 120_000, () =>
      (logs().match(/form fill: extension .* connected on desktop main/g) ?? []).length > before ? true : undefined
    )
    const doctor = JSON.parse(docker('exec', name, 'agentconnect-computer', 'doctor', '--json', '--daemon')) as {
      checks?: Array<{ name: string; status: string; detail: string }>
    }
    const checks = doctor.checks ?? (doctor as unknown as Array<{ name: string; status: string; detail: string }>)
    expect(checks.filter((check) => check.name.startsWith('form fill'))).toEqual([
      expect.objectContaining({ name: 'form fill', status: 'ok' }),
      expect.objectContaining({ name: 'form fill browsers', status: 'ok' })
    ])
    // The agent's desktop starts again on its next call, and its browser keeps the extension it installed before.
    await a.start()
    await a.open('/vanilla.html')
    const result = await a.fill(await a.discover(), { username: 'after-restart' })
    expect(result.status).toBe('filled')
    await until('the plain form report after the restart', 10_000, () =>
      lastReport('vanilla', 'a')?.username === 'after-restart' ? true : undefined
    )
  }, 300_000)

  it('keeps every value out of results, the daemon log and the audit log', () => {
    const audit = docker('exec', name, 'cat', '/home/computer/.agentconnect/computer/audit.log')
    const browserLogs = spawnSync(
      'docker',
      ['exec', name, 'sh', '-c', 'cat /home/computer/.agentconnect/computer/desktops/*/browser.log 2>/dev/null'],
      { encoding: 'utf8' }
    ).stdout
    expect(audit).toContain('computer_form_fill')
    for (const value of Object.values(CANARY)) {
      expect(results.join('\n')).not.toContain(value)
      expect(logs()).not.toContain(value)
      expect(audit).not.toContain(value)
      expect(browserLogs).not.toContain(value)
    }
  })
})

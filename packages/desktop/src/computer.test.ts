import { describe, expect, it } from 'vitest'
import { redactArgs, type AuditRecord } from './audit.js'
import { Computer, type ToolOutput } from './computer.js'
import { FakeDriver, testConfig } from './testing.js'

function setup(
  overrides: Parameters<typeof testConfig>[0] = {},
  platform: NodeJS.Platform = 'win32',
  refusal: () => string | undefined = () => undefined
) {
  const driver = new FakeDriver()
  let now = 1_000_000
  const audit: AuditRecord[] = []
  const statuses: string[] = []
  const computer = new Computer({
    driver,
    config: testConfig({ humanIdleSeconds: 5, ...overrides }),
    audit: (record) => audit.push(record),
    now: () => now,
    sleep: async () => undefined,
    onStatus: (status) => statuses.push(status),
    platform,
    refusal
  })
  return { driver, computer, audit, statuses, advance: (ms: number) => (now += ms) }
}

const errorOf = (output: ToolOutput): Record<string, unknown> => {
  expect(output.isError).toBe(true)
  return JSON.parse(output.content.find((block) => block.type === 'text')!.text!) as Record<string, unknown>
}

describe('Computer', () => {
  it('captures before the first coordinate action and returns a post-action screenshot', async () => {
    const { driver, computer } = setup()
    const output = await computer.click('claude', { x: 10, y: 20 })
    expect(output.isError).toBeUndefined()
    expect(driver.inputCalls()).toEqual(['get_desktop_state', 'click', 'get_desktop_state'])
    expect(driver.calls.find((call) => call.name === 'click')!.args).toEqual({ scope: 'desktop', x: 10, y: 20 })
    expect(output.content.some((block) => block.type === 'image')).toBe(true)
  })

  it('recaptures after the driver restarts because the capture mapping is lost', async () => {
    const { driver, computer } = setup({ actionScreenshot: false })
    await computer.click('claude', { x: 1, y: 1 })
    driver.starts++
    await computer.move('claude', { x: 2, y: 2 })
    expect(driver.inputCalls()).toEqual(['get_desktop_state', 'click', 'get_desktop_state', 'move_cursor'])
  })

  it('gives the control lease to one client at a time', async () => {
    const { computer, statuses } = setup({ actionScreenshot: false })
    await computer.type('claude', { text: 'hi' })
    expect(errorOf(await computer.type('codex', { text: 'hi' }))).toMatchObject({
      error: 'computer_busy',
      holder: 'claude'
    })
    expect((await computer.screenshot('codex')).isError).toBeUndefined()
    expect(computer.release('codex')).toBe(false)
    expect(computer.release('claude')).toBe(true)
    expect((await computer.type('codex', { text: 'hi' })).isError).toBeUndefined()
    expect(statuses).toEqual(['controlled by claude', 'online', 'controlled by codex'])
  })

  it('expires an idle lease', async () => {
    const { computer, advance } = setup({ actionScreenshot: false, leaseIdleSeconds: 60 })
    await computer.type('claude', { text: 'hi' })
    advance(61_000)
    expect((await computer.type('codex', { text: 'hi' })).isError).toBeUndefined()
  })

  it('blocks input but not screenshots while the owner has paused the computer', async () => {
    const { computer, driver } = setup({ actionScreenshot: false })
    await computer.type('claude', { text: 'hi' })
    computer.pause('emergency stop')
    expect(errorOf(await computer.click('claude', { x: 1, y: 1 }))).toMatchObject({ error: 'human_in_control' })
    expect((await computer.screenshot('claude')).isError).toBeUndefined()
    expect(driver.inputCalls().filter((name) => name === 'click')).toEqual([])
    computer.resume()
    expect((await computer.click('claude', { x: 1, y: 1 })).isError).toBeUndefined()
  })

  it('reports human_active after pointer movement it did not cause, then recovers when idle', async () => {
    const { computer, driver, advance } = setup({ actionScreenshot: false })
    await computer.move('claude', { x: 5, y: 5 })
    await computer.pollCursor()
    driver.cursor = { x: 700, y: 300 }
    await computer.pollCursor()
    expect(errorOf(await computer.click('claude', { x: 1, y: 1 }))).toMatchObject({ error: 'human_active' })
    advance(6_000)
    expect((await computer.click('claude', { x: 1, y: 1 })).isError).toBeUndefined()
  })

  it('does not treat its own pointer moves as human input', async () => {
    const { computer, driver } = setup({ actionScreenshot: false })
    driver.handlers.move_cursor = (args) => {
      driver.cursor = { x: Number(args.x), y: Number(args.y) }
      return { content: [{ type: 'text', text: 'moved' }] }
    }
    await computer.move('claude', { x: 5, y: 5 })
    await computer.pollCursor()
    await computer.move('claude', { x: 400, y: 400 })
    await computer.pollCursor()
    expect((await computer.click('claude', { x: 1, y: 1 })).isError).toBeUndefined()
  })

  it('returns uncertain with a fresh screenshot and never replays the action', async () => {
    const { computer, driver, audit } = setup()
    await computer.screenshot('claude')
    driver.failNextWithUncertain('click')
    const output = await computer.click('claude', { x: 10, y: 10 })
    expect(errorOf(output)).toMatchObject({ error: 'uncertain' })
    expect(output.content.some((block) => block.type === 'image')).toBe(true)
    expect(driver.inputCalls().filter((name) => name === 'click')).toHaveLength(1)
    expect(audit.at(-1)).toMatchObject({ tool: 'computer_click', outcome: 'error', code: 'uncertain' })
  })

  it('maps keys to press_key or hotkey and refuses OS-level shortcuts', async () => {
    const { computer, driver } = setup({ actionScreenshot: false })
    await computer.key('claude', { keys: ['Enter'] })
    await computer.key('claude', { keys: ['s', 'Control'] })
    expect(driver.calls.filter((call) => call.name === 'press_key' || call.name === 'hotkey')).toEqual([
      { name: 'press_key', args: { scope: 'desktop', key: 'return' } },
      { name: 'hotkey', args: { scope: 'desktop', keys: ['ctrl', 's'] } }
    ])
    expect(errorOf(await computer.key('claude', { keys: ['win', 'r'] }))).toMatchObject({ error: 'denied' })
    expect(errorOf(await computer.key('claude', { keys: ['ctrl', 'alt', 'delete'] }))).toMatchObject({
      error: 'denied'
    })
    expect(errorOf(await computer.key('claude', { keys: ['ctrl', 'shift'] }))).toMatchObject({
      error: 'invalid_argument'
    })
  })

  for (const platform of ['win32', 'linux'] as const) {
    it(`applies the same key and text limits to raw driver tools on ${platform}`, async () => {
      const { computer, driver } = setup({ actionScreenshot: false }, platform)
      for (const [name, args] of [
        ['hotkey', { keys: ['win', 'r'] }],
        ['hotkey', { keys: ['ctrl', 'alt', 'delete'] }],
        ['press_key', { key: 'super' }],
        ['press_key', { key: 'Win+R' }],
        ['click', { x: 1, y: 1, modifier: ['meta'] }]
      ] as const) {
        expect(errorOf(await computer.driverTool('claude', name, { ...args }, false))).toMatchObject({
          error: 'denied'
        })
      }
      expect(
        errorOf(await computer.driverTool('claude', 'type_text', { text: 'x'.repeat(4097) }, false))
      ).toMatchObject({ error: 'invalid_argument' })
      expect(driver.calls).toEqual([])
      expect((await computer.driverTool('claude', 'hotkey', { keys: ['ctrl', 's'] }, false)).isError).toBeUndefined()
      expect(driver.calls.map((call) => call.name)).toContain('hotkey')
    })
  }

  it('allows raw driver system keys when allowSystemKeys is on', async () => {
    const { computer } = setup({ actionScreenshot: false, allowSystemKeys: true })
    expect((await computer.driverTool('claude', 'hotkey', { keys: ['win', 'r'] }, false)).isError).toBeUndefined()
  })

  it('allows everyday Cmd shortcuts on macOS but refuses lock, log out and force quit', async () => {
    const { computer, driver } = setup({ actionScreenshot: false }, 'darwin')
    expect((await computer.key('claude', { keys: ['cmd', 'a'] })).isError).toBeUndefined()
    expect((await computer.click('claude', { x: 1, y: 1, modifiers: ['cmd'] })).isError).toBeUndefined()
    expect(driver.calls.find((call) => call.name === 'hotkey')!.args).toEqual({ scope: 'desktop', keys: ['cmd', 'a'] })
    for (const keys of [
      ['ctrl', 'cmd', 'q'],
      ['cmd', 'shift', 'q'],
      ['cmd', 'option', 'esc']
    ]) {
      expect(errorOf(await computer.key('claude', { keys }))).toMatchObject({ error: 'denied' })
    }
  })

  it('reports the cursor in screenshot pixels', async () => {
    const { computer, driver } = setup()
    driver.cursor = { x: 1000, y: 500 }
    const output = await computer.cursorPosition('claude')
    expect(JSON.parse(output.content[0]!.text!)).toEqual({ x: 500, y: 250 })
  })

  it('audits every call and redacts typed text', async () => {
    const { computer, audit } = setup({ actionScreenshot: false })
    await computer.type('claude', { text: 'secret' })
    expect(audit.at(-1)).toMatchObject({ client: 'claude', tool: 'computer_type', outcome: 'ok' })
    expect(redactArgs(audit.at(-1)!.args)).toEqual({ text: '<6 chars>' })
  })

  it('blocks agents while a viewer holds control and maps viewer fractions to capture pixels', async () => {
    const { driver, computer, audit } = setup({ actionScreenshot: false })
    await computer.click('claude', { x: 1, y: 1 })
    await expect(computer.viewerInput('alice', { type: 'click', x: 0.5, y: 0.5 })).rejects.toMatchObject({
      code: 'human_in_control'
    })
    computer.takeOver('alice')
    expect(computer.info().lease).toBeNull()
    expect(errorOf(await computer.click('claude', { x: 1, y: 1 })).error).toBe('human_in_control')
    expect(() => computer.takeOver('bob')).toThrow(/remote takeover by alice/)

    await computer.viewerInput('alice', { type: 'click', x: 0.5, y: 1, button: 'right' })
    await computer.viewerInput('alice', { type: 'key', keys: ['win'] })
    const calls = driver.calls.filter((call) => call.name === 'click' || call.name === 'press_key').slice(-2)
    expect(calls.map((call) => call.args)).toEqual([
      { scope: 'desktop', x: 640, y: 719, button: 'right' },
      { scope: 'desktop', key: 'win' }
    ])
    expect(audit.at(-1)).toMatchObject({ client: 'alice', tool: 'viewer_key', outcome: 'ok' })

    expect(computer.handBack('bob')).toBe(false)
    expect(computer.handBack('alice')).toBe(true)
    expect((await computer.click('claude', { x: 1, y: 1 })).isError).toBeUndefined()
  })

  for (const [revoke, wait] of [
    ['pause', 'behind a screenshot'],
    ['hand back', 'behind a screenshot'],
    ['pause', 'for its own capture']
  ] as const) {
    it(`drops viewer input revoked by ${revoke} while it waits ${wait}`, async () => {
      const { driver, computer } = setup({ actionScreenshot: false })
      const capture = driver.handlers.get_desktop_state!
      let finish!: () => void
      const gate = new Promise<void>((resolve) => (finish = resolve))
      driver.handlers.get_desktop_state = async (args) => {
        await gate
        return capture(args)
      }
      computer.takeOver('alice')
      const shot = wait === 'behind a screenshot' ? computer.screenshot('claude') : undefined
      const click = computer.viewerInput('alice', { type: 'click', x: 0.5, y: 0.5 })
      if (revoke === 'pause') computer.pause('emergency stop')
      else computer.handBack('alice')
      finish()
      await shot
      await expect(click).rejects.toMatchObject({ code: 'human_in_control' })
      expect(driver.calls.filter((call) => call.name === 'click')).toEqual([])
    })
  }

  it('types non-ASCII text on Linux one remapped character at a time', async () => {
    const { driver, computer } = setup({ actionScreenshot: false }, 'linux')
    await computer.type('claude', { text: 'ok 你好!' })
    expect(driver.calls.filter((call) => call.name === 'type_text').map((call) => call.args.text)).toEqual([
      'ok ',
      '你',
      '好',
      '!'
    ])
  })

  it('stops a segmented Linux typing call at the next segment once the authority is revoked', async () => {
    let refusal: string | undefined
    const { driver, computer } = setup({ actionScreenshot: false }, 'linux', () => refusal)
    const original = driver.call.bind(driver)
    driver.call = async (name: string, args: Record<string, unknown>) => {
      const result = await original(name, args)
      if (name === 'type_text' && !refusal) {
        refusal = 'computer key revoked'
        computer.suspend(refusal)
      }
      return result
    }
    const output = await computer.type('claude', { text: '你好世界' })
    expect(errorOf(output)).toMatchObject({ error: 'unavailable' })
    expect(String(errorOf(output).message)).toMatch(/stopped after typing 1 of 4 characters/)
    expect(driver.calls.filter((call) => call.name === 'type_text').map((call) => call.args.text)).toEqual(['你'])
  })

  it('stops a segmented Linux typing call when the owner pauses mid-way', async () => {
    const { driver, computer } = setup({ actionScreenshot: false }, 'linux')
    const original = driver.call.bind(driver)
    driver.call = async (name: string, args: Record<string, unknown>) => {
      const result = await original(name, args)
      if (name === 'type_text') computer.pause('emergency stop')
      return result
    }
    expect(errorOf(await computer.type('claude', { text: '你好' }))).toMatchObject({ error: 'human_in_control' })
    expect(driver.calls.filter((call) => call.name === 'type_text')).toHaveLength(1)
  })
})

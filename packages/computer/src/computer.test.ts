import { describe, expect, it } from 'vitest'
import { redactArgs, type AuditRecord } from './audit.js'
import type { ComputerAdminPromptMode } from '@agentconnect.md/protocol/computer'
import type { AdminPrompt, AdminPromptSource } from './admin-prompts.js'
import { Computer, type ToolOutput } from './computer.js'
import { DriverToolError } from './driver/client.js'
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
  it('describes the machine from its profile and the startup screen size until the first capture', async () => {
    const computer = new Computer({
      driver: new FakeDriver(),
      config: testConfig(),
      profile: { name: 'browser-1', osVersion: 'Debian GNU/Linux 13 (trixie)', session: 'xvfb', isolation: 'container' }
    })
    expect(computer.info()).toMatchObject({ name: 'browser-1', session: 'xvfb', isolation: 'container', display: null })
    computer.rename('Build server desktop')
    expect(computer.info()).toMatchObject({ name: 'Build server desktop', isolation: 'container' })
    computer.setScreenSize({ screenWidth: 1600, screenHeight: 900, scale: 1 })
    expect(computer.info().display).toEqual({ screenWidth: 1600, screenHeight: 900, scale: 1 })
    await computer.screenshot('claude')
    expect(computer.info().display).toMatchObject({ screenshotWidth: expect.any(Number) })
  })

  it('captures before the first coordinate action and returns a post-action screenshot', async () => {
    const { driver, computer } = setup()
    const output = await computer.click('claude', { x: 10, y: 20 })
    expect(output.isError).toBeUndefined()
    expect(driver.inputCalls()).toEqual(['get_desktop_state', 'click', 'get_desktop_state'])
    expect(driver.calls.find((call) => call.name === 'click')!.args).toEqual({ scope: 'desktop', x: 10, y: 20 })
    expect(output.content.some((block) => block.type === 'image')).toBe(true)
  })

  it('reports a click the driver sent as delivered when it moved the foreground to another process', async () => {
    const { driver, computer } = setup({ actionScreenshot: false })
    const failure = (text: string) => () => {
      throw new DriverToolError('click', { content: [{ type: 'text', text }] })
    }
    driver.handlers.click = failure(
      'foreground_unavailable: exact target HWND 0x4023a or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x102ae)'
    )
    const sent = await computer.click('claude', { x: 10, y: 20 })
    expect(sent.isError).toBeUndefined()
    expect(sent.content[0]!.text).toMatch(/^Click sent/)
    driver.handlers.click = failure('foreground_unavailable: could not bring HWND 0x1 to the foreground')
    expect(errorOf(await computer.click('claude', { x: 10, y: 20 }))).toMatchObject({ error: 'driver_error' })
  })

  it('launches through its own launcher instead of the driver when it has one', async () => {
    const driver = new FakeDriver()
    const launched: string[] = []
    const computer = new Computer({
      driver,
      config: testConfig({ actionScreenshot: false }),
      sleep: async () => undefined,
      launchApp: async (app) => (launched.push(app), `launched ${app} (pid 42)`)
    })
    const output = await computer.launch('claude', { app: 'notepad' })
    expect(launched).toEqual(['notepad'])
    expect(output.content).toEqual([{ type: 'text', text: 'launched notepad (pid 42)' }])
    expect(driver.inputCalls()).not.toContain('launch_app')
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

  describe('the Control Plane lease', () => {
    const AGENT = '00000000-0000-4000-8000-0000000000bb'
    // The caller name a channel token for session sess-1 of AGENT gets: agent and session together.
    const SESS_1 = `${AGENT}/sess-1`
    const told = (sessionId: string, leaseId = `lease-${sessionId}`) => ({
      leaseId,
      computerId: '00000000-0000-4000-8000-000000000001',
      holder: { sessionId, agentId: AGENT, agentName: 'Ops' },
      acquiredAt: '2026-10-20T00:00:00.000Z',
      expiresAt: '2026-10-20T00:30:00.000Z'
    })

    it('lets only the holder it was told about take control, naming that holder to anyone else', async () => {
      const { computer } = setup({ actionScreenshot: false })
      computer.applyControlLease(told('sess-1'))
      expect(errorOf(await computer.type('claude', { text: 'hi' }))).toMatchObject({
        error: 'computer_busy',
        holder: 'Ops',
        sessionId: 'sess-1'
      })
      // The same session id under another agent is not the holder.
      expect(errorOf(await computer.type('00000000-0000-4000-8000-0000000000cc/sess-1', { text: 'hi' }))).toMatchObject(
        {
          error: 'computer_busy'
        }
      )
      expect((await computer.type(SESS_1, { text: 'hi' })).isError).toBeUndefined()
      expect(computer.info().controlLease).toMatchObject({ leaseId: 'lease-sess-1' })
    })

    it('drops a local lease the Control Plane moved to another session or ended', async () => {
      const { computer, statuses } = setup({ actionScreenshot: false })
      await computer.type('claude', { text: 'hi' })
      computer.applyControlLease(told('sess-1'))
      expect(computer.liveStatus()).toBe('online')
      await computer.type(SESS_1, { text: 'hi' })
      // A renewal under a fresh id for the same session keeps the local lease.
      computer.applyControlLease(told('sess-1', 'lease-again'))
      expect(computer.liveStatus()).toBe('busy')
      computer.applyControlLease(null)
      expect(computer.liveStatus()).toBe('online')
      expect(statuses).toEqual(['controlled by claude', 'online', `controlled by ${SESS_1}`, 'online'])
      // With no lease told, the local tokens of an unregistered prototype still work.
      expect((await computer.type('claude', { text: 'hi' })).isError).toBeUndefined()
      computer.applyControlLease(null)
      expect(computer.liveStatus()).toBe('busy')
    })

    it("reports the local lease's holder, idle time and time held", async () => {
      const { computer, advance } = setup({ actionScreenshot: false })
      expect(computer.leaseActivity()).toBeUndefined()
      await computer.type(SESS_1, { text: 'hi' })
      advance(1000)
      await computer.type(SESS_1, { text: 'again' })
      advance(1500)
      expect(computer.leaseActivity()).toEqual({ holder: SESS_1, idleMs: 1500, heldMs: 2500 })
    })
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

  it('reports human_active after a key or button the person pressed, even before any lease', async () => {
    const { computer, driver, advance } = setup({ actionScreenshot: false })
    computer.noteHumanInput()
    expect(errorOf(await computer.type('claude', { text: 'hi' }))).toMatchObject({
      error: 'human_active',
      retryAfterMs: 5000
    })
    expect(driver.inputCalls().filter((name) => name === 'type_text')).toEqual([])
    advance(5_001)
    expect((await computer.type('claude', { text: 'hi' })).isError).toBeUndefined()
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

describe('administrator prompts (computer-use.md §4.2.1)', () => {
  const PROMPT: AdminPrompt = {
    id: '1',
    kind: 'consent',
    app: 'Windows Command Processor',
    publisher: 'Verified publisher: Microsoft Windows',
    command: '"C:\\Windows\\system32\\cmd.exe" /c whoami',
    lines: []
  }

  function prompts(mode: ComputerAdminPromptMode | undefined, prompt: AdminPrompt | undefined = PROMPT) {
    const answers: Array<[string, string]> = []
    const source: { current: AdminPrompt | undefined } & AdminPromptSource = {
      current: prompt,
      problem: undefined,
      pending: () => source.current,
      answer: async (id: string, answer: string) => {
        answers.push([id, answer])
        source.current = undefined
      }
    }
    const driver = new FakeDriver()
    const audit: AuditRecord[] = []
    const computer = new Computer({
      driver,
      config: testConfig({ actionScreenshot: false, humanIdleSeconds: 0 }),
      audit: (record) => audit.push(record),
      sleep: async () => undefined,
      adminPrompts: { source, mode: () => mode }
    })
    return { computer, source, answers, audit, driver }
  }

  it('tells the agent about a waiting prompt that screenshots cannot show, and holds other input until it is answered', async () => {
    const { computer, driver } = prompts('agent')
    const shot = await computer.screenshot('claude')
    const note = JSON.parse(shot.content.at(-1)!.text!) as Record<string, unknown>
    expect(note).toMatchObject({ admin_prompt: { kind: 'consent', app: 'Windows Command Processor' } })
    expect(note.note).toContain('computer_admin_prompt')
    expect(errorOf(await computer.click('claude', { x: 1, y: 1 }))).toMatchObject({
      error: 'admin_prompt_pending',
      adminPrompt: { command: PROMPT.command }
    })
    expect(driver.inputCalls()).not.toContain('click')
    // The secure desktop refuses capture: the prompt in words stands in for the screenshot.
    driver.handlers.get_desktop_state = () => {
      throw new DriverToolError('get_desktop_state', { content: [{ type: 'text', text: 'BitBlt failed' }] })
    }
    const refused = await computer.screenshot('claude')
    expect(refused.isError).toBeUndefined()
    expect(JSON.parse(refused.content[0]!.text!)).toMatchObject({ admin_prompt: { kind: 'consent' } })
  })

  it('lets the agent answer in the agent mode, takes the lease and audits what it approved', async () => {
    const { computer, answers, audit } = prompts('agent')
    const output = await computer.adminPrompt('claude', { answer: 'approve' }, undefined)
    expect(JSON.parse(output.content[0]!.text!)).toMatchObject({ answered: 'approve' })
    expect(answers).toEqual([['1', 'approve']])
    expect(computer.info().lease).toMatchObject({ holder: 'claude' })
    expect(audit.at(-1)).toMatchObject({
      tool: 'computer_admin_prompt',
      outcome: 'ok',
      args: { answer: 'approve', app: 'Windows Command Processor' }
    })
    expect(errorOf(await computer.adminPrompt('claude', { answer: 'deny' }, undefined))).toMatchObject({
      error: 'no_admin_prompt'
    })
  })

  it("needs a person's approval to approve in the people mode, the default, but never to deny", async () => {
    const people = prompts(undefined)
    expect(
      errorOf(await people.computer.adminPrompt('claude', { answer: 'approve' }, 'allowed_session'))
    ).toMatchObject({
      error: 'approval_required',
      adminPrompt: { app: 'Windows Command Processor' }
    })
    expect(people.answers).toEqual([])
    await people.computer.adminPrompt('claude', { answer: 'approve' }, 'allowed')
    expect(people.answers).toEqual([['1', 'approve']])
    const deny = prompts('people')
    await deny.computer.adminPrompt('claude', { answer: 'deny' }, undefined)
    expect(deny.answers).toEqual([['1', 'deny']])
  })

  it('leaves a password prompt to a person, whatever the mode', async () => {
    const { computer, answers } = prompts('agent', { ...PROMPT, kind: 'credentials' })
    expect(errorOf(await computer.adminPrompt('claude', { answer: 'approve' }, 'allowed'))).toMatchObject({
      error: 'denied'
    })
    await computer.adminPrompt('claude', { answer: 'deny' }, undefined)
    expect(answers).toEqual([['1', 'deny']])
  })

  it('answers by itself in the always modes, only while an agent holds control, and once per prompt', async () => {
    const idle = prompts('approve')
    await idle.computer.adminPromptChanged()
    expect(idle.answers).toEqual([])

    const { computer, source, answers, audit } = prompts('deny')
    computer.acquire('claude')
    await Promise.all([computer.adminPromptChanged(), computer.adminPromptChanged()])
    expect(answers).toEqual([['1', 'deny']])
    expect(audit.at(-1)).toMatchObject({ client: 'claude', tool: 'admin_prompt_auto', outcome: 'ok' })
    source.current = { ...PROMPT, id: '2' }
    expect(errorOf(await computer.adminPrompt('claude', { answer: 'approve' }, 'allowed'))).toMatchObject({
      error: 'denied'
    })
    const password = prompts('approve', { ...PROMPT, kind: 'credentials' })
    password.computer.acquire('claude')
    await password.computer.adminPromptChanged()
    expect(password.answers).toEqual([])
  })
})

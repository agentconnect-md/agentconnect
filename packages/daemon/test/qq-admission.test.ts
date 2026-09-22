import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiClient, TokenManager } from '@tencent-connect/qqbot-nodejs/protocol'
import { normalizeQQMessage } from '@agentconnect.md/message'
import { Daemon } from '../src/daemon.js'
import { QQConnection } from '../src/platforms/qq/connection.js'

let daemon: Daemon | undefined
let root: string | undefined
const releases: (() => void)[] = []
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { promise, release }
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  await daemon?.stop()
  if (root) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function boot(
  opts: {
    startup?: Promise<void>
    work?: Promise<void>
    acknowledgement?: Promise<void>
    mode?: string
    steering?: boolean
  } = {}
) {
  root = mkdtempSync(join(tmpdir(), 'ac-qq-admission-'))
  const dir = join(root, 'agents', 'qq-agent')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { turnFinalContextRefresh: false, sessionSteering: true },
      runtimes: { opencode: { command: 'node', args: ['unused'] } }
    })
  )
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify({
      id: 'qq-agent',
      name: 'QQ Agent',
      runtime: 'opencode',
      status: 'active',
      workspace: { mode: 'from-scratch', path: join(dir, 'workspace') },
      integrations: [
        {
          id: 'qq-install',
          platform: 'qq',
          core: { mode: 'direct', bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }] },
          config: { appId: '100', appSecret: 'secret' }
        }
      ],
      output: { mode: opts.mode ?? 'low' }
    })
  )
  vi.spyOn(QQConnection.prototype, 'start').mockResolvedValue()
  vi.spyOn(TokenManager.prototype, 'getAccessToken').mockResolvedValue('token')
  const request = vi.spyOn(ApiClient.prototype, 'request').mockImplementation(async (_token, _method, _path, body) => {
    if ((body as { msg_type?: number })?.msg_type === 0) await opts.acknowledgement
    return { id: 'reply' }
  })
  const prompts: string[] = []
  const steer = vi.fn(async () => 'injected')
  daemon = new Daemon({
    root,
    hostFactory: (_agent, update) =>
      ({
        start: async () => {},
        stop: async () => {},
        cancel: async () => {},
        newSession: async () => {
          await opts.startup
          return 'session'
        },
        hasSession: () => true,
        steeringSupported: () => opts.steering === true,
        steer,
        prompt: async (session: string, blocks: { text?: string }[]) => {
          prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
          if (prompts.length === 1) await opts.work
          update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } })
          return 'end_turn'
        }
      }) as any
  })
  await daemon.start()
  await vi.waitFor(() => expect((daemon as any).QQConnByIntegration.size).toBe(1))
  const deliver = async (id: string, isDm = false) => {
    const message = normalizeQQMessage(
      '100',
      {
        rawEventType: isDm ? 'C2C_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE',
        kind: isDm ? 'c2c' : 'group',
        groupOpenid: 'g1',
        senderId: 'user',
        messageId: id,
        content: `${isDm ? '' : '<@!100> '}request ${id}`
      },
      `trace-${id}`
    )!
    const outcome = await (daemon as any).onInboundOutcome(message, ['qq-install'])
    if (outcome.kind === 'dispatched') await outcome.handle.admission
    return outcome
  }
  const acknowledgements = () =>
    request.mock.calls.filter((call) => (call[3] as { msg_type?: number })?.msg_type === 0).map((call) => call[3])
  return { deliver, prompts, request, acknowledgements, steer }
}

describe('QQ group admission feedback', () => {
  it('acknowledges cold startup and queued messages before any agent output, with no duplicate receipt', async () => {
    const startup = gate()
    const { deliver, prompts, acknowledgements } = await boot({ startup: startup.promise })
    const first = await deliver('first')
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(1))
    expect(prompts).toHaveLength(0)
    expect(acknowledgements()[0]).toMatchObject({
      content: '👀',
      msg_id: 'first',
      message_reference: { message_id: 'first' }
    })
    const second = await deliver('second')
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(2))
    expect(acknowledgements()[1]).toMatchObject({
      content: '⏳',
      msg_id: 'second',
      message_reference: { message_id: 'second' }
    })
    expect(prompts).toHaveLength(0)
    expect((await deliver('first')).kind).toBe('rejected')
    expect(acknowledgements()).toHaveLength(2)
    startup.release()
    await Promise.all([first.handle.completion, second.handle.completion])
    expect(prompts).toHaveLength(2)
    expect(acknowledgements()).toHaveLength(2)
  })

  it('acknowledges steering as added to the current task rather than queued', async () => {
    const work = gate()
    const { deliver, prompts, acknowledgements, steer } = await boot({ work: work.promise, steering: true })
    const first = await deliver('first')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    await deliver('correction')
    await vi.waitFor(() => expect(acknowledgements()).toHaveLength(2))
    expect(steer).toHaveBeenCalledOnce()
    expect(acknowledgements()[1]).toMatchObject({
      content: '📝',
      message_reference: { message_id: 'correction' }
    })
    expect(prompts).toHaveLength(1)
    work.release()
    await first.handle.completion
    expect(prompts).toHaveLength(1)
  })

  it('starts the runtime without waiting for the acknowledgement API', async () => {
    const acknowledgement = gate()
    const { deliver, prompts, acknowledgements } = await boot({ acknowledgement: acknowledgement.promise })
    const first = await deliver('first')
    await vi.waitFor(() => expect(prompts).toHaveLength(1))
    expect(acknowledgements()).toHaveLength(1)
    acknowledgement.release()
    await first.handle.completion
  })

  it.each([
    { mode: 'none', paused: false },
    { mode: 'high', paused: true }
  ])('does not acknowledge silent or rejected turns (mode=$mode, paused=$paused)', async ({ mode, paused }) => {
    const { deliver, acknowledgements } = await boot({ mode })
    if (paused) (daemon as any).agents.get('qq-agent').pause = true
    const turn = await deliver('request')
    if (paused) expect(await turn.handle.admission).toMatchObject({ admitted: false })
    await turn.handle.completion
    expect(acknowledgements()).toHaveLength(0)
  })
})

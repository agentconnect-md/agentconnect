import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-daemon-ack-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', 'bot-a')
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: 'bot-a',
      name: 'bot-a',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [],
      output: { mode: 'medium' }
    })
  )
  return root
}

async function harness() {
  const root = scaffold()
  const fakeHost = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => 'acp-ack-1'),
    hasSession: (id: string) => id === 'acp-ack-1',
    prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
    cancel: vi.fn(),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    slackAppFactory: fakeSlackAppFactory(),
    root,
    hostFactory: () => fakeHost as never
  })
  await daemon.start()
  const react = vi.fn(async () => {})
  vi.spyOn(daemon as never as { replyConnFor: () => unknown }, 'replyConnFor').mockReturnValue({
    react,
    setStatus: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
    postMessage: vi.fn(async () => 'reply-ts'),
    postContext: vi.fn(async () => {})
  })
  return {
    react,
    dispatch: (msg: Record<string, unknown>) =>
      (daemon as never as { dispatch: (a: string, m: unknown) => Promise<unknown> }).dispatch('bot-a', {
        traceId: 'ack',
        source: 'user',
        sender: { id: 'U1', isBot: false },
        text: 'hello',
        mentionedBots: [],
        isDm: false,
        ...msg
      }),
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('turn-start acknowledgement', () => {
  it('reacts on the message that started the turn, addressed by its native coordinates', async () => {
    const h = await harness()
    try {
      await h.dispatch({ msgId: 'telegram:-1002233:87', platform: 'telegram', channel: '-1002233' })
      expect(h.react).toHaveBeenCalledWith('-1002233', '87', 'seen')
    } finally {
      await h.close()
    }
  })

  it('addresses a discord thread message by its own container, not the parent channel', async () => {
    const h = await harness()
    try {
      // The normalizer reports the PARENT channel; only the id's container can be reacted to.
      await h.dispatch({
        msgId: 'discord:99887766:11223344',
        platform: 'discord',
        channel: '55550000',
        thread: '99887766'
      })
      expect(h.react).toHaveBeenCalledWith('99887766', '11223344', 'seen')
    } finally {
      await h.close()
    }
  })

  it('stays silent for an origin with no inbound message to react to', async () => {
    const h = await harness()
    try {
      await h.dispatch({ msgId: 'telegram:-1002233:87', platform: 'telegram', channel: '-1002233', source: 'cron' })
      await h.dispatch({ msgId: 'telegram:-1002233:88', platform: 'telegram', channel: '-1002233', source: 'agent' })
      expect(h.react).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })

  it('stays silent when the id is not a normalizer-minted coordinate', async () => {
    const h = await harness()
    try {
      await h.dispatch({
        msgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:delivery-1',
        platform: 'hook',
        channel: 'hook:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        source: 'hook'
      })
      expect(h.react).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})

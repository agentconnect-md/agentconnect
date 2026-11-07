import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon } from '../src/daemon.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { isAppendCoordinate } from '../src/session/append-coordinate.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'

// A cron or hook fired into an append-mode room joins the session a person's message there joins (#3639).

const AGENT = 'bot-a'
const INT = 'int-bot-a'

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-trigger-append-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const adir = join(root, 'agents', AGENT)
  mkdirSync(adir, { recursive: true })
  writeFileSync(
    join(adir, 'agent.json'),
    JSON.stringify({
      id: AGENT,
      name: AGENT,
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: join(adir, 'workspace') },
      integrations: [
        {
          id: INT,
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: [{ channel: 'C1', mode: 'append' }]
          },
          config: { botToken: 'xoxb', appToken: 'xapp' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot() {
  const root = scaffold()
  const daemon = new Daemon({
    root,
    hostFactory: () =>
      ({
        __started: true,
        start: vi.fn(async () => {}),
        newSession: vi.fn(async () => 'acp-1'),
        prompt: vi.fn(async () => 'end_turn'),
        cancel: vi.fn(),
        stop: vi.fn()
      }) as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const inner = daemon as never as Record<string, unknown>
  const dispatched: NormalizedMessage[] = []
  inner.dispatch = vi.fn(async (_agentId: string, msg: NormalizedMessage) => {
    dispatched.push(msg)
    return 'acp-1'
  })
  // No anchor post: the coordinate is resolved before it, which is what these cases are about.
  inner.replyConnFor = () => undefined
  const person = async (ts: string) => {
    await (inner.onInboundOutcome as (m: unknown, s: string[]) => Promise<unknown>).call(
      daemon,
      {
        msgId: `slack:C1:${ts}`,
        traceId: 't',
        source: 'user',
        platform: 'slack',
        channel: 'C1',
        sender: { id: 'U1', isBot: false },
        text: 'hello',
        mentionedBots: [],
        isDm: false,
        ts
      },
      [INT]
    )
    return dispatched.at(-1)!
  }
  const trigger = (source: 'cron' | 'hook'): NormalizedMessage =>
    ({
      msgId: `${source}:1:t`,
      traceId: 't',
      source,
      platform: 'slack',
      channel: 'C1',
      thread: `${source}:1:t`,
      sender: { id: `${source}:1`, isBot: false },
      text: 'run the digest',
      mentionedBots: [],
      isDm: false
    }) as NormalizedMessage
  return {
    daemon,
    inner,
    dispatched,
    person,
    trigger,
    async close() {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

describe('a trigger fired into an append-mode room', () => {
  it('runs a cron in the session a person already started there', async () => {
    const h = await boot()
    try {
      const human = await h.person('1720000000.000100')
      await (h.inner.onCronFire as (a: string, m: NormalizedMessage, c: unknown) => Promise<void>).call(
        h.daemon,
        AGENT,
        h.trigger('cron'),
        {
          id: 'digest',
          trigger: 'run the digest',
          schedule: '0 9 * * 1',
          target: { channel: 'C1', integrationId: INT }
        }
      )
      const fire = h.dispatched.at(-1)!
      expect(fire.source).toBe('cron')
      expect(isAppendCoordinate(human.sessionThread)).toBe(true)
      expect(fire.sessionThread).toBe(human.sessionThread)
      expect(fire.transportScope).toBe(human.transportScope)
    } finally {
      await h.close()
    }
  })

  it('puts a person who posts after a hook fired into the hook’s session', async () => {
    const h = await boot()
    try {
      const { message: fire } = await (
        h.inner.anchorTrigger as (
          a: string,
          m: NormalizedMessage,
          t: { channel: string; integrationId: string },
          text: string,
          label: string
        ) => Promise<{ message: NormalizedMessage | null }>
      ).call(h.daemon, AGENT, h.trigger('hook'), { channel: 'C1', integrationId: INT }, 'A PR opened', 'hook "h1"')
      const human = await h.person('1720000000.000200')
      expect(isAppendCoordinate(fire!.sessionThread)).toBe(true)
      expect(human.sessionThread).toBe(fire!.sessionThread)
      expect(human.transportScope).toBe(fire!.transportScope)
    } finally {
      await h.close()
    }
  })
})

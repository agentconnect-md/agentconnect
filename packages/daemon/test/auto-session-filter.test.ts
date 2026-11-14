// auto-session-mode.md §4.7: the coordinator filter screens an unaddressed message before the coordinator reads it.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DecisionEvaluation } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import {
  COORDINATOR_FILTER_QUESTION,
  COORDINATOR_FILTER_SKIP_BELOW,
  coordinatorFilterAdmits,
  screensCoordinatorMessage
} from '../src/auto-session/coordinator-filter.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const slack = (ts: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage =>
  ({
    msgId: `slack:C1:${ts}`,
    traceId: `t-${ts}`,
    source: 'user',
    platform: 'slack',
    channel: 'C1',
    thread: ts,
    sender: { id: 'U1', isBot: false },
    text: 'hello',
    mentionedBots: [],
    isDm: false,
    ...over
  }) as NormalizedMessage

const answered = (probability: number): DecisionEvaluation => ({
  status: 'answered',
  answer: { type: 'boolean', value: probability >= 0.5, probability },
  model: 'jev-1.13.0',
  usage: { inputTokens: 1, outputTokens: 1 }
})

describe('which messages the filter screens and lets through', () => {
  it('screens only an unaddressed root message from a person', () => {
    expect(screensCoordinatorMessage({ msg: slack('1.1') })).toBe(true)
    expect(screensCoordinatorMessage({ msg: slack('1.1', { trigger: 'mention' }) })).toBe(false)
    expect(screensCoordinatorMessage({ msg: slack('1.2', { thread: '1.1' }) })).toBe(false)
    expect(screensCoordinatorMessage({ msg: slack('1.1', { source: 'agent' }) })).toBe(false)
    expect(screensCoordinatorMessage({ msg: slack('1.1', { platform: 'webchat' }) })).toBe(false)
    expect(screensCoordinatorMessage({ msg: slack('1.1'), callMeta: {} })).toBe(false)
  })

  it('skips only a confident No, and lets an unavailable answer through', () => {
    expect(COORDINATOR_FILTER_QUESTION.type).toBe('boolean')
    expect(coordinatorFilterAdmits(answered(COORDINATOR_FILTER_SKIP_BELOW - 0.01))).toBe(false)
    expect(coordinatorFilterAdmits(answered(COORDINATOR_FILTER_SKIP_BELOW))).toBe(true)
    expect(coordinatorFilterAdmits(answered(0.4))).toBe(true)
    expect(coordinatorFilterAdmits({ status: 'unavailable', reason: 'timeout' })).toBe(true)
  })
})

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), 'ac-coordinator-filter-'))
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      features: { autoSessionMode: true },
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
      coordinatorFilter: { providerId: 'typesafe', model: 'jev-1.13.0' },
      integrations: [
        {
          id: 'int-bot-a',
          platform: 'slack',
          core: {
            bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'auto' }, channel: 'C1' }],
            sessionModes: [{ channel: 'C1', mode: 'auto' }]
          },
          config: { botToken: 'xoxb', appToken: 'xapp', botUserId: 'U_FAKE_BOT' }
        }
      ],
      output: { mode: 'low' }
    })
  )
  return root
}

async function boot(prompt: (blocks: { type: string; text?: string }[]) => Promise<unknown>) {
  let sessions = 0
  const host = {
    __started: true,
    start: vi.fn(async () => {}),
    newSession: vi.fn(async () => `acp-${++sessions}`),
    prompt: vi.fn(async (_sessionId: string, blocks: { type: string; text?: string }[]) => prompt(blocks)),
    cancel: vi.fn(async () => {}),
    stop: vi.fn()
  }
  const daemon = new Daemon({
    root: scaffold(),
    hostFactory: () => host as never,
    slackAppFactory: fakeSlackAppFactory()
  })
  await daemon.start()
  const d = daemon as any
  d.bindSessionSource = async () => 'unchanged'
  // The model's answer by message text: "chatter" is a confident No, "outage" leaves the provider unavailable.
  const asked: string[] = []
  d.decisionEvaluator.evaluate = vi.fn(async (input: { state: { currentMessage?: { text?: string } } }) => {
    const text = input.state.currentMessage?.text ?? ''
    asked.push(text)
    // An answer takes a while, as a provider's does, so the queue waits on it.
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (text.includes('outage')) return { status: 'unavailable', reason: 'provider' } satisfies DecisionEvaluation
    return answered(text.includes('chatter') ? 0.05 : 0.9)
  })
  const route = async (msg: NormalizedMessage) => await d.onInboundOutcome(msg, ['int-bot-a'])
  return { daemon, d, host, route, asked }
}

describe('a coordinator with a filter', () => {
  it('drops a confident No from its batch, and never asks about a mention', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const prompts: string[] = []
    const { daemon, d, route, asked } = await boot(async (blocks) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
      if (prompts.length === 1) await held
      return 'end_turn'
    })
    await route(slack('1.1', { text: 'can someone look at the deploy' }))
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    await route(slack('1.2', { text: 'chatter about lunch' }))
    await route(slack('1.3', { text: '<@U_FAKE_BOT> chatter but addressed', mentionedBots: ['U_FAKE_BOT'] }))
    await route(slack('1.4', { text: 'outage while asking' }))
    // All three wait in the coordinator's queue before the running turn ends, so one batch decides them.
    const queued = () => [...(d.serialQueue as Map<string, unknown[]>).values()].reduce((n, q) => n + q.length, 0)
    await vi.waitFor(() => expect(queued()).toBe(3), WAIT)
    release()
    // The second coordinator turn decides the batch; the unanswered mention then opens a task of its own (§4.5).
    const batch = () => prompts.find((prompt) => prompt.includes('id="msg-1.3"'))
    await vi.waitFor(() => expect(batch()).toBeDefined(), WAIT)
    await vi.waitFor(() => expect(d.inflight.size).toBe(0), WAIT)
    expect(prompts[0]).toContain('id="msg-1.1"')
    expect(batch()).toContain('id="msg-1.4"')
    expect(prompts.some((prompt) => prompt.includes('msg-1.2') || prompt.includes('chatter about lunch'))).toBe(false)
    expect(asked).toEqual(['can someone look at the deploy', 'chatter about lunch', 'outage while asking'])
    // Each verdict is recorded for the console's Recent evaluations, newest first; the mention was never asked.
    const rows = await d.store.listCoordinatorFilterEvaluations('', 'bot-a', undefined, 10)
    const summaries = rows.map((row: { summaryJson: string }) => JSON.parse(row.summaryJson))
    expect(
      summaries.map((one: { messageId: string; outcome: string; title: string }) => [
        one.messageId,
        one.outcome,
        one.title
      ])
    ).toEqual([
      ['slack:C1:1.4', 'unavailable', 'outage while asking'],
      ['slack:C1:1.2', 'skipped', 'chatter about lunch'],
      ['slack:C1:1.1', 'triggered', 'can someone look at the deploy']
    ])
    expect(summaries[1]).toMatchObject({ decisionId: 'coordinator-filter', answer: { type: 'boolean', value: false } })
    expect(summaries[0]).toMatchObject({ reason: 'provider', answer: null })
    const detail = JSON.parse(rows[1].detailJson)
    expect(detail.snapshot).toMatchObject({
      providerId: 'typesafe',
      model: 'jev-1.13.0',
      question: COORDINATOR_FILTER_QUESTION
    })
    expect(detail.input.currentMessage.text).toBe('chatter about lunch')
    await daemon.stop()
  })

  it('opens no turn for a skipped message that finds the coordinator idle', async () => {
    const prompts: string[] = []
    const { daemon, d, route } = await boot(async (blocks) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
      return 'end_turn'
    })
    await route(slack('2.1', { text: 'chatter, nothing for anyone' }))
    await vi.waitFor(() => expect(d.inflight.size).toBe(0), WAIT)
    expect(prompts).toEqual([])
    await route(slack('2.2', { text: 'please rerun the nightly job' }))
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(prompts[0]).toContain('id="msg-2.2"')
    expect(prompts[0]).not.toContain('id="msg-2.1"')
    await daemon.stop()
  })

  it('asks nothing once the filter is removed', async () => {
    const prompts: string[] = []
    const { daemon, d, route, asked } = await boot(async (blocks) => {
      prompts.push(blocks.map((block) => block.text ?? '').join('\n'))
      return 'end_turn'
    })
    delete d.agents.get('bot-a').coordinatorFilter
    await route(slack('3.1', { text: 'chatter again' }))
    await vi.waitFor(() => expect(prompts).toHaveLength(1), WAIT)
    expect(asked).toEqual([])
    await daemon.stop()
  })
})

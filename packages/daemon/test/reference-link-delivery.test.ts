import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { OutputConverger } from '../src/slack/render.js'
import { TelegramConverger } from '../src/telegram/render.js'
import { DiscordConverger } from '../src/discord/render.js'
import { FeishuConverger } from '../src/feishu/render.js'
import { GithubReplyCollector } from '../src/github/poster.js'

const chunk = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text }
})

const bodies = (actions: Array<{ kind: string; text?: string }>) =>
  actions
    .filter((action) =>
      ['post', 'live-reply', 'final-live-reply', 'card-stream', 'card-final', 'reasoning'].includes(action.kind)
    )
    .map((action) => action.text)

describe.each([
  { name: 'Slack', create: (mode: 'low' | 'minimal') => new OutputConverger(mode) },
  { name: 'Telegram', create: (mode: 'low' | 'minimal') => new TelegramConverger(mode) },
  { name: 'Discord', create: (mode: 'low' | 'minimal') => new DiscordConverger(mode) },
  { name: 'Feishu', create: (mode: 'low' | 'minimal') => new FeishuConverger(mode) }
])('$name reference delivery', ({ create }) => {
  it('does not activate an outer host link when its nested link is flattened', () => {
    const c = create('low')
    c.onUpdate(chunk('[report [source](/home/agent/source.md)](/home/agent/report.md)'))
    expect(bodies(c.onFinal())).toContain('\\[report source (`source.md`)](/home/agent/report.md)')
  })

  it.each(['final', 'terminal'])(
    'holds incomplete reference definitions out of previews until %s completion',
    (completion) => {
      const c = create('minimal')
      c.onUpdate(chunk('Earlier paragraph.\n\nRead [the digest][r].\n\n[r]: </home/agent/secret'))
      expect(bodies(c.flushBuffered())).toEqual(['Earlier paragraph.\n\n'])
      c.onUpdate(chunk('.md>'))
      expect(bodies(c.flushBuffered()).every((text) => text === 'Earlier paragraph.\n\n')).toBe(true)
      const finished =
        completion === 'final' ? c.onFinal() : 'flushTerminal' in c ? c.flushTerminal() : c.onFailure('Agent stopped')
      const final = bodies(finished).map((text) => text?.trim())
      expect(final).toContain('Earlier paragraph.\n\nRead the digest (`secret.md`).')
    }
  )

  it.each(['low', 'minimal'] as const)(
    'does not emit an empty %s reply after removing a standalone unsafe definition',
    (mode) => {
      const c = create(mode)
      c.onUpdate(chunk('[r]: /home/agent/secret.md'))
      expect(bodies(c.flushBuffered())).toEqual([])
      expect(bodies(c.onFinal())).toEqual([])
    }
  )
})

it('removes a newly activated host link from the shared code-host reply', () => {
  const reply = new GithubReplyCollector()
  reply.onUpdate(chunk('[report [source](/home/agent/source.md)](/home/agent/report.md)'))
  expect(reply.finalText()).toBe('\\[report source (`source.md`)](/home/agent/report.md)')
})

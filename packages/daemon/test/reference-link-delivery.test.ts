import { describe, expect, it } from 'vitest'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { OutputConverger } from '../src/slack/render.js'
import { TelegramConverger } from '../src/telegram/render.js'
import { DiscordConverger } from '../src/discord/render.js'
import { FeishuConverger } from '../src/feishu/render.js'
import { GithubReplyCollector } from '../src/github/poster.js'
import { LinearConverger } from '../src/platforms/linear/turn-output.js'
import { createWorkspaceFileLinkResolver } from '../src/messages/workspace-file-links.js'

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
    expect(bodies(c.onFinal())).toContain('\\[report source (`source.md`)\\](/home/agent/report.md)')
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
  expect(reply.finalText()).toBe('\\[report source (`source.md`)\\](/home/agent/report.md)')
})

const resolveFileLink = createWorkspaceFileLinkResolver({
  sessionUrl: 'https://console.example.test/acme/sessions/current',
  agentId: 'agent-1',
  cwd: '/agent/session/workspace',
  roots: [{ path: '/agent/session/workspace' }]
})

it.each([
  { name: 'Slack', create: () => new OutputConverger('minimal', [], resolveFileLink) },
  { name: 'Telegram', create: () => new TelegramConverger('minimal', {}, resolveFileLink) },
  { name: 'Discord', create: () => new DiscordConverger('minimal', resolveFileLink) },
  { name: 'Feishu', create: () => new FeishuConverger('minimal', resolveFileLink) }
])('opens a split workspace reference in the $name reply', ({ create }) => {
  const c = create()
  c.onUpdate(chunk('Read [the report][r].\n\n[r]: /agent/session/work'))
  expect(bodies(c.flushBuffered())).toEqual([])
  c.onUpdate(chunk('space/report.md'))
  const finished = bodies(c.onFinal()).filter((body) => body?.includes('Read '))
  expect(finished.length).toBeGreaterThan(0)
  for (const body of finished) {
    expect(body).toContain(resolveFileLink('report.md'))
    expect(body).not.toContain('/agent/session/')
  }
})

it('opens workspace files in the shared code-host final while preserving repository-relative links', () => {
  const reply = new GithubReplyCollector()
  reply.onUpdate(chunk('[report][r] and [source](src/main.ts).\n\n[r]: /agent/session/workspace/report.md'))
  const final = reply.finalText(true, { resolvesRelativeTargets: true, resolveFileLink })
  expect(final).toContain(resolveFileLink('report.md'))
  expect(final).toContain('[source](src/main.ts)')
  expect(final).not.toContain('/agent/session/')
})

it('opens relative workspace files in the Linear final response', () => {
  const c = new LinearConverger('minimal', false, resolveFileLink)
  c.onUpdate(chunk('[report](report.md)'))
  const final = c.onFinal().find((action) => action.kind === 'activity' && action.type === 'response')
  expect(final).toMatchObject({
    kind: 'activity',
    type: 'response',
    body: expect.stringContaining(resolveFileLink('report.md')!)
  })
})

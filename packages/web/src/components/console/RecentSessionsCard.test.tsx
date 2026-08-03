// The row's second line, which now has two tenants: the conversation's agents on
// the left and its integration anchored right. Both are text of unbounded length
// inside a fixed-width card, so the contract under test is that neither can push
// the other — or itself — past the row's edge, and that a conversation is named by
// everyone in it rather than by whichever member spoke last.

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ orgPath: (path: string) => path })
}))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    crons: [],
    getAgent: (id: string) => (id === 'agent-1' ? { id, name: 'ops-bot', runtime: 'claude' } : undefined)
  })
}))

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: ReactElement; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  )
}))

import { RecentSessionsCard } from './RecentSessionsCard'
import type { Session } from '@/lib/data'

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    title: 'Who are you',
    time: '9:19 AM',
    status: 'online',
    platform: 'slack',
    channel: '#ops',
    user: 'sam',
    duration: '1m',
    tokens: '2.1K',
    cost: '$0.01',
    toolCount: '1',
    statusLabel: 'completed',
    steps: [],
    agentId: 'agent-1',
    agentName: 'ops-bot',
    ...overrides
  }
}

const card = (sessions: Session[], showAgent = true) =>
  renderToStaticMarkup(
    <RecentSessionsCard
      sessions={sessions}
      loading={false}
      allHref="/sessions"
      emptyText="none"
      showAgent={showAgent}
    />
  )

/** The class list of the `<span>` wrapping the platform mark + channel label —
 *  i.e. the span one level out from the `imark` the mark itself renders into. */
function channelWrapperClasses(markup: string): string {
  const mark = markup.indexOf('<span class="imark')
  expect(mark).toBeGreaterThan(-1)
  const open = markup.lastIndexOf('<span class="', mark - 1) + '<span class="'.length
  return markup.slice(open, markup.indexOf('"', open))
}

describe('RecentSessionsCard', () => {
  it('lets a long channel label ellipsize instead of overflowing the row', () => {
    const long = '#platform-infra-oncall-handoff-and-escalations-archive'
    const markup = card([session({ channel: long })])
    // `flex-none` here would size the wrapper to the full label, defeating the
    // `truncate` inside it — the label must be able to give way.
    expect(channelWrapperClasses(markup)).toContain('min-w-0')
    expect(channelWrapperClasses(markup)).not.toContain('flex-none')
    expect(markup).toContain('mono truncate text-[11px]')
    expect(markup).toContain(long) // present in full; the ellipsis is the browser's
  })

  it('keeps the channel left-packed where the row has no agents to split from', () => {
    expect(channelWrapperClasses(card([session()], false))).not.toContain('ml-auto')
    expect(channelWrapperClasses(card([session()]))).toContain('ml-auto')
  })

  it('names every participant of a multi-agent conversation', () => {
    const markup = card([
      session({
        conversationKey: 'conv-1',
        memberSessionIds: ['s1', 's2'],
        agentName: 'ops-bot',
        participants: [
          { agentId: 'agent-1', name: 'agent-1', primary: true },
          { agentId: 'agent-2', name: 'test' }
        ]
      })
    ])
    // agent-1 resolves through the org directory; agent-2 is unknown there, so its
    // roster name stands in — an id would render as the "Agent" fallback.
    expect(markup).toContain('ops-bot, test')
    expect(markup).toContain('/conversations/conv-1')
  })

  it('draws one face and one name for a single-agent row', () => {
    const markup = card([session()])
    expect(markup).toContain('ops-bot')
    expect(markup).toContain('/sessions/s1')
    expect(markup).not.toContain('-space-x-')
  })
})

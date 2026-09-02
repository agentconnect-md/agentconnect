// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  )
}))

import { WorkspaceScopePicker, worktreeIdentity } from './WorkspaceScopePicker'
import type { Session } from '@/lib/data'
import { sessionIsolationLabel } from '@/lib/session-isolation'

// Built by the helper, never spelled out here, so the picker's copy cannot drift from the labels the helper decides.
const UNCONFINED = sessionIsolationLabel({
  pool: false,
  runInSandbox: false,
  sandboxSupported: false,
  sandboxRequired: false
})
const CONFINED = sessionIsolationLabel({
  pool: false,
  runInSandbox: true,
  sandboxSupported: true,
  sandboxRequired: false
})

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-576',
    title: 'PR #576: fix(auth): make selected visibility explicit',
    time: '3:09 PM',
    status: 'online',
    platform: 'hook',
    channel: 'GitHub',
    user: 'GitHub',
    duration: '1m',
    tokens: '2.1K',
    cost: '$0.01',
    toolCount: '1',
    statusLabel: 'completed',
    steps: [],
    workspaceIsolation: 'session',
    ...overrides
  }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('WorkspaceScopePicker', () => {
  it('separates a PR coordinate from its title', () => {
    expect(worktreeIdentity(session({}), 'session-576')).toEqual({
      context: 'PR #576',
      title: 'fix(auth): make selected visibility explicit',
      fullTitle: 'PR #576: fix(auth): make selected visibility explicit'
    })
  })

  it('opens the worktree menu and keeps selection separate from Session navigation', async () => {
    const onChange = vi.fn()
    const onLoadMore = vi.fn()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <WorkspaceScopePicker
          primaryBranch="release/2026-08"
          isolationLabel={UNCONFINED}
          sessions={[
            session({}),
            session({ id: 'session-568', title: 'PR #568: bind the conversation audience', time: '3:10 PM' }),
            session({ id: 'session-shared', workspaceIsolation: 'shared' }),
            session({ id: 'session-purged', contentPurgedAt: '2026-08-04T00:00:00.000Z' })
          ]}
          selectedSessionId="session-576"
          selectedSession={session({})}
          loading={false}
          hasMore
          loadingMore={false}
          onChange={onChange}
          onLoadMore={onLoadMore}
          orgPath={(path) => `/agentconnect${path}`}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Workspace checkout:"]')!
    expect(trigger.textContent).toContain('PR #576')
    expect(trigger.textContent).toContain('fix(auth): make selected visibility explicit')
    expect(trigger.querySelector('[title]')?.getAttribute('title')).toBe(
      'PR #576: fix(auth): make selected visibility explicit · 3:09 PM'
    )
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/agentconnect/sessions/session-576')

    await act(async () => trigger.click())

    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.textContent).toContain('release/2026-08')
    expect(menu.textContent).not.toContain('Primary checkout')
    // The heading is the label verbatim; `.eyebrow` is what uppercases it on screen, so the DOM text is lower case.
    expect(menu.textContent).toContain('worktrees·2')
    expect(menu.textContent).toContain('PR #568')
    expect(menu.textContent).not.toContain('3:10 PM')
    expect(menu.textContent).toContain('Showing 2 recent worktrees')

    const other = Array.from(menu.querySelectorAll<HTMLButtonElement>('[data-workspace-choice]')).find((choice) =>
      choice.textContent?.includes('PR #568')
    )!
    expect(other.title).toBe('PR #568: bind the conversation audience · 3:10 PM')
    await act(async () => other.click())
    expect(onChange).toHaveBeenCalledWith('session-568')
    expect(container.querySelector('[role="menu"]')).toBeNull()

    await act(async () => trigger.click())
    const loadOlder = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Load older'
    )!
    await act(async () => loadOlder.click())
    expect(onLoadMore).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('drops the worktree vocabulary where a boundary encloses the runtime', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <WorkspaceScopePicker
          primaryBranch="main"
          isolationLabel={CONFINED}
          sessions={[session({}), session({ id: 'session-568', title: 'PR #568: bind the audience' })]}
          selectedSessionId={null}
          loading={false}
          hasMore={false}
          loadingMore={false}
          onChange={vi.fn()}
          onLoadMore={vi.fn()}
          orgPath={(path) => `/agentconnect${path}`}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Workspace checkout:"]')!
    await act(async () => trigger.click())

    const menu = container.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.textContent).toContain('session checkouts·2')
    expect(menu.textContent).toContain('Showing 2 recent session checkouts')
    expect(menu.textContent).not.toContain('worktree')
  })

  it('shows the branch without a menu when no worktrees are available', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <WorkspaceScopePicker
          primaryBranch="main"
          isolationLabel={UNCONFINED}
          sessions={[]}
          selectedSessionId={null}
          loading={false}
          hasMore={false}
          loadingMore={false}
          onChange={vi.fn()}
          onLoadMore={vi.fn()}
          orgPath={(path) => `/agentconnect${path}`}
        />
      )
    )

    expect(container.textContent).toContain('main')
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps older worktrees reachable when the current page has none', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <WorkspaceScopePicker
          primaryBranch="main"
          isolationLabel={UNCONFINED}
          sessions={[]}
          selectedSessionId={null}
          loading={false}
          hasMore
          loadingMore={false}
          onChange={vi.fn()}
          onLoadMore={vi.fn()}
          orgPath={(path) => `/agentconnect${path}`}
        />
      )
    )

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Workspace checkout: main"]')!
    await act(async () => trigger.click())

    expect(container.querySelector('[role="menu"]')?.textContent).toContain('Load older')
  })
})

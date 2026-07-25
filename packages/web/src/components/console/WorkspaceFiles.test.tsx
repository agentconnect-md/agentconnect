import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  fetchWorkspaceFile: vi.fn(),
  fetchWorkspaceFileFull: vi.fn(),
  fetchWorkspaceFiles: vi.fn(),
  fetchWorkspaceGitStatus: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  workspaceGitPull: vi.fn()
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => false }))

import { WorkspaceFiles, workspaceReadModelKey } from './WorkspaceFiles'
import type { Agent } from '@/lib/data'

it('uses configured edit access even before runtime Git status loads', () => {
  const html = renderToStaticMarkup(
    <WorkspaceFiles agentId="agent-a" workdir="/workspace" canEdit renderHeader={() => null} />
  )
  expect(html).toContain('New file')
})

// The workspace editor lives in the card this browser renders, so a replacement
// has to remount the instance — otherwise the previous tree/preview/git state
// survives underneath a refreshed source card (and GitHub → scratch turns the
// stale GitHub preview editable).
describe('workspaceReadModelKey', () => {
  const github = {
    id: 'agent-a',
    workdir: '/ws/agent-a',
    workspace: { mode: 'github', repo: 'acme/infra', branch: 'main', agentDir: '/' }
  } as unknown as Pick<Agent, 'id' | 'workspace' | 'workdir'>

  const keyOf = (over: Record<string, unknown> = {}, workspaceOver: Record<string, unknown> = {}) =>
    workspaceReadModelKey({
      ...github,
      ...over,
      workspace: { ...github.workspace, ...workspaceOver }
    } as Pick<Agent, 'id' | 'workspace' | 'workdir'>)

  it('is stable while the workspace identity is unchanged', () => {
    expect(keyOf()).toBe(workspaceReadModelKey(github))
  })

  it.each([
    ['repository', { repo: 'acme/web' }],
    ['branch', { branch: 'next' }],
    ['working subdirectory', { agentDir: '/services/api' }],
    ['mode', { mode: 'scratch' }]
  ])('changes when the %s changes', (_label, workspaceOver) => {
    expect(keyOf({}, workspaceOver)).not.toBe(workspaceReadModelKey(github))
  })

  it('changes when the daemon-local working directory moves', () => {
    expect(keyOf({ workdir: '/ws/agent-a-2' })).not.toBe(workspaceReadModelKey(github))
  })

  it('separates two agents that share a workspace definition', () => {
    expect(keyOf({ id: 'agent-b' })).not.toBe(workspaceReadModelKey(github))
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

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

import { WorkspaceFiles } from './WorkspaceFiles'

it('uses configured edit access even before runtime Git status loads', () => {
  const html = renderToStaticMarkup(<WorkspaceFiles agentId="agent-a" workdir="/workspace" canEdit />)
  expect(html).toContain('New file')
})

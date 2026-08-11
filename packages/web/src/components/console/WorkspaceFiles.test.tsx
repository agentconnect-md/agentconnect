// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mobile = vi.hoisted(() => ({ value: false }))
const workspace = vi.hoisted(() => ({
  exists: true,
  entries: [] as Array<{
    name: string
    type: 'file' | 'dir'
    size: number | null
    mtime: string | null
  }>,
  listings: {} as Record<
    string,
    Array<{
      name: string
      type: 'file' | 'dir'
      size: number | null
      mtime: string | null
    }>
  >,
  file: {
    path: 'README.md',
    exists: true,
    size: 17,
    mtime: '2026-07-25T09:00:00.000Z',
    encoding: 'utf8' as const,
    content: '# Workspace\n',
    offset: 0,
    nextOffset: 17,
    truncated: false
  }
}))

vi.mock('next/dynamic', () => ({ default: () => () => null }))
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  deleteWorkspaceFile: vi.fn(),
  fetchWorkspaceFile: vi.fn(() => Promise.resolve(workspace.file)),
  fetchWorkspaceFileFull: vi.fn(() => Promise.resolve(workspace.file)),
  fetchWorkspaceFiles: vi.fn((_agentId: string, opts: { path: string }) =>
    Promise.resolve({
      entries: opts.path ? (workspace.listings[opts.path] ?? []) : workspace.entries,
      exists: workspace.exists,
      nextCursor: null
    })
  ),
  fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
  writeWorkspaceFile: vi.fn(),
  workspaceGitPull: vi.fn()
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mobile.value }))

import { WorkspaceFiles, workspaceReadModelKey } from './WorkspaceFiles'
import { deleteWorkspaceFile, fetchWorkspaceFiles, fetchWorkspaceGitStatus, writeWorkspaceFile } from '@/lib/api'
import type { Agent } from '@/lib/data'

let container: HTMLDivElement | undefined
let root: ReturnType<typeof createRoot> | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

async function renderWorkspace() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<WorkspaceFiles agentId="agent-a" workdir="/workspace" canEdit renderHeader={() => null} />)
    await Promise.resolve()
  })
}

async function rerenderWorkspace() {
  await act(async () => {
    root?.render(<WorkspaceFiles agentId="agent-a" workdir="/workspace" canEdit renderHeader={() => null} />)
  })
}

async function clickButton(label: string) {
  const button = Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button, `${label} button`).toBeDefined()
  await act(async () => button?.click())
}

async function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  container = undefined
  root = undefined
  mobile.value = false
  workspace.exists = true
  workspace.entries = []
  workspace.listings = {}
  vi.mocked(deleteWorkspaceFile).mockClear()
  vi.mocked(fetchWorkspaceFiles).mockClear()
  vi.mocked(fetchWorkspaceGitStatus).mockClear()
  vi.mocked(fetchWorkspaceGitStatus).mockImplementation(() =>
    Promise.resolve({
      isRepo: false,
      clean: true,
      repo: null,
      agentDir: null,
      branch: null,
      tracking: null,
      ahead: null,
      behind: null,
      files: [],
      truncated: false,
      lastCommit: null,
      lastFetchAt: null
    })
  )
  vi.mocked(writeWorkspaceFile).mockClear()
})

it('uses configured edit access even before runtime Git status loads', () => {
  const html = renderToStaticMarkup(
    <WorkspaceFiles agentId="agent-a" workdir="/workspace" canEdit renderHeader={() => null} />
  )
  expect(html).toContain('Add file')
})

it('places the checkout selector in the file browser header', () => {
  const html = renderToStaticMarkup(
    <WorkspaceFiles
      agentId="agent-a"
      workdir="/workspace"
      canEdit={false}
      renderWorkspacePicker={() => <span data-testid="workspace-picker">Checkout</span>}
      renderHeader={() => <div data-testid="source-card">Source</div>}
    />
  )
  const host = document.createElement('div')
  host.innerHTML = html
  const picker = host.querySelector('[data-testid="workspace-picker"]')

  expect(picker?.closest('.cardhead')).not.toBeNull()
  expect(picker?.closest('.card')?.querySelector('[data-testid="source-card"]')).toBeNull()
  expect(picker?.parentElement?.className).toContain('w-1/4')
})

it('uses the primary checkout live branch while browsing a worktree', async () => {
  vi.mocked(fetchWorkspaceGitStatus).mockImplementation((_agentId, sessionId) =>
    Promise.resolve({
      isRepo: true,
      clean: true,
      repo: 'https://github.com/acme/infra.git',
      agentDir: '/',
      branch: sessionId ? 'worktree-branch' : 'primary-live-branch',
      tracking: null,
      ahead: 0,
      behind: 0,
      files: [],
      truncated: false,
      lastCommit: null,
      lastFetchAt: null
    })
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <WorkspaceFiles
        agentId="agent-a"
        sessionId="session-a"
        workdir="/workspace"
        canEdit={false}
        renderWorkspacePicker={(branch) => <span data-testid="primary-branch">{branch}</span>}
        renderHeader={() => null}
      />
    )
    await Promise.resolve()
  })

  expect(container.querySelector('[data-testid="primary-branch"]')?.textContent).toBe('primary-live-branch')
  expect(fetchWorkspaceGitStatus).toHaveBeenCalledWith('agent-a', 'session-a')
  expect(fetchWorkspaceGitStatus).toHaveBeenCalledWith('agent-a')
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

  it('separates the primary checkout from a session worktree', () => {
    expect(workspaceReadModelKey(github, 'session-a')).not.toBe(workspaceReadModelKey(github))
  })
})

it('scopes file and git reads to the selected session worktree', async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <WorkspaceFiles
        agentId="agent-a"
        sessionId="session-a"
        workdir="/workspace"
        canEdit={false}
        renderHeader={() => null}
      />
    )
    await Promise.resolve()
  })

  expect(fetchWorkspaceFiles).toHaveBeenCalledWith('agent-a', { path: '', sessionId: 'session-a' })
  expect(fetchWorkspaceGitStatus).toHaveBeenCalledWith('agent-a', 'session-a')
  expect(container?.textContent).not.toContain('Add file')
})

it('explains when a selected session workspace has been cleaned up', async () => {
  workspace.exists = false
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <WorkspaceFiles
        agentId="agent-a"
        sessionId="session-a"
        workdir="/workspace"
        canEdit={false}
        renderHeader={() => null}
      />
    )
    await Promise.resolve()
  })

  expect(container.textContent).toContain("This session's workspace has been cleaned up")
  expect(container.textContent).toContain('it will be recreated from the repository')
  expect(container.textContent).not.toContain('The workspace has no files yet')
})

it('keeps an inline new-file draft across the desktop-to-mobile breakpoint', async () => {
  await renderWorkspace()
  await clickButton('Add file')

  const path = container?.querySelector<HTMLInputElement>('input[aria-label="New file path"]')
  const content = container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')
  expect(path).not.toBeNull()
  expect(content).not.toBeNull()
  await changeValue(path!, 'notes.md')
  await changeValue(content!, 'unsaved draft')

  mobile.value = true
  await rerenderWorkspace()

  const editor = container?.querySelector('form[aria-label="New file"]')
  const mobilePath = container?.querySelector<HTMLInputElement>('input[aria-label="New file path"]')
  const mobileContent = container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')
  expect(editor?.closest('.card')).not.toBeNull()
  expect(mobilePath?.value).toBe('notes.md')
  expect(mobileContent?.value).toBe('unsaved draft')
  expect(container?.querySelector('[role="dialog"]')).toBeNull()
  expect(container?.querySelector('.scrim')).toBeNull()
})

it('creates from the current breadcrumb without repeating path labels in the editor', async () => {
  workspace.entries = [
    {
      name: 'docs',
      type: 'dir',
      size: null,
      mtime: null
    }
  ]
  workspace.listings.docs = [
    {
      name: 'README.md',
      type: 'file',
      size: workspace.file.size,
      mtime: workspace.file.mtime
    }
  ]
  vi.mocked(writeWorkspaceFile).mockClear()
  await renderWorkspace()
  await clickButton('docs')
  await act(async () => Promise.resolve())
  await clickButton('README.md')
  await clickButton('Add file')

  const breadcrumb = container?.querySelector<HTMLElement>('nav[aria-label="Workspace path"]')
  const path = container?.querySelector<HTMLInputElement>('input[aria-label="New file path"]')
  const content = container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')
  expect(breadcrumb?.textContent).toContain('workspace')
  expect(breadcrumb?.textContent).toContain('docs')
  expect(path?.closest('nav')).toBe(breadcrumb)
  expect(breadcrumb?.closest('.cardhead')?.textContent).toContain('Cancel')
  expect(breadcrumb?.closest('.cardhead')?.textContent).toContain('Save changes')
  expect(breadcrumb?.closest('.cardhead')?.textContent).not.toContain('Create file')
  expect(container?.textContent).not.toContain('Scratch workspace')
  expect(container?.textContent).not.toContain('Workspace-relative path')

  await changeValue(path!, 'notes.md')
  await changeValue(content!, 'draft')
  await clickButton('Save changes')
  expect(writeWorkspaceFile).toHaveBeenCalledWith('agent-a', 'docs/notes.md', { content: 'draft' })
})

it('turns slash-separated new-file directories into breadcrumb segments', async () => {
  await renderWorkspace()
  await clickButton('Add file')

  let path = container?.querySelector<HTMLInputElement>('input[aria-label="New file path"]')
  const content = container?.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')
  await changeValue(path!, 'guides/setup/')

  const breadcrumb = container?.querySelector<HTMLElement>('nav[aria-label="Workspace path"]')
  path = container?.querySelector<HTMLInputElement>('input[aria-label="New file path"]')
  expect(breadcrumb?.textContent).toContain('guides')
  expect(breadcrumb?.textContent).toContain('setup')
  expect(path?.value).toBe('')

  await changeValue(path!, 'README.md')
  await changeValue(content!, '# Setup')
  await clickButton('Save changes')
  expect(writeWorkspaceFile).toHaveBeenCalledWith('agent-a', 'guides/setup/README.md', { content: '# Setup' })
})

it('loads and expands the directories a new-file path names', async () => {
  workspace.entries = [{ name: 'guides', type: 'dir', size: null, mtime: null }]
  workspace.listings = {
    guides: [{ name: 'setup', type: 'dir', size: null, mtime: null }],
    'guides/setup': [{ name: 'intro.md', type: 'file', size: 4, mtime: null }]
  }
  await renderWorkspace()
  await clickButton('Add file')

  const path = container?.querySelector<HTMLInputElement>('input[aria-label="New file path"]')
  await changeValue(path!, 'guides/setup/')
  await act(async () => Promise.resolve())

  // Each typed segment is fetched and left open, so the tree behind the draft shows where the file is about to land.
  const requested = vi.mocked(fetchWorkspaceFiles).mock.calls.map((call) => call[1].path)
  expect(requested).toContain('guides')
  expect(requested).toContain('guides/setup')
  expect(container?.textContent).toContain('intro.md')
})

it('keeps file identity in the breadcrumb and confirms deletion inline', async () => {
  workspace.entries = [
    {
      name: 'README.md',
      type: 'file',
      size: workspace.file.size,
      mtime: workspace.file.mtime
    }
  ]
  await renderWorkspace()
  await clickButton('README.md')

  const previewPane = container?.querySelector('[data-file-browser-pane="preview"]')
  expect(previewPane?.textContent).not.toContain('README.md')
  await clickButton('Delete')
  expect(container?.querySelector('[role="alert"]')?.textContent).toContain('Delete this file?')
  expect(container?.querySelector('[role="dialog"]')).toBeNull()

  await clickButton('Delete file')
  expect(deleteWorkspaceFile).toHaveBeenCalledWith('agent-a', 'README.md', workspace.file.mtime)
})

it('reopens the mobile preview before confirming deletion from the file list', async () => {
  mobile.value = true
  workspace.entries = [
    {
      name: 'README.md',
      type: 'file',
      size: workspace.file.size,
      mtime: workspace.file.mtime
    }
  ]
  await renderWorkspace()
  await clickButton('README.md')

  const previewPane = container?.querySelector('[data-file-browser-pane="preview"]')
  const back = container?.querySelector<HTMLButtonElement>('button[aria-label="Back to files"]')
  expect(back).not.toBeNull()
  await act(async () => back?.click())
  expect(previewPane?.classList.contains('hidden')).toBe(true)

  await clickButton('Delete')
  expect(previewPane?.classList.contains('flex')).toBe(true)
  expect(previewPane?.classList.contains('hidden')).toBe(false)
  expect(previewPane?.querySelector('[role="alert"]')?.textContent).toContain('Delete this file?')
})

it('returns mobile Cancel and Escape to the existing file preview', async () => {
  mobile.value = true
  workspace.entries = [
    {
      name: 'README.md',
      type: 'file',
      size: workspace.file.size,
      mtime: workspace.file.mtime
    }
  ]
  await renderWorkspace()
  await clickButton('README.md')
  await clickButton('Edit')
  const breadcrumb = container?.querySelector<HTMLElement>('nav[aria-label="Workspace path"]')
  expect(breadcrumb?.textContent).toContain('README.md')
  expect(breadcrumb?.closest('.cardhead')?.textContent).toContain('Save changes')
  expect(container?.textContent).not.toContain('Editing')
  await clickButton('Cancel')

  const previewPane = container?.querySelector('[data-file-browser-pane="preview"]')
  expect(previewPane?.classList.contains('flex')).toBe(true)
  expect(previewPane?.classList.contains('hidden')).toBe(false)
  expect(container?.querySelector('form[aria-label="Edit README.md"]')).toBeNull()

  await clickButton('Edit')
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
  expect(previewPane?.classList.contains('flex')).toBe(true)
  expect(previewPane?.classList.contains('hidden')).toBe(false)
  expect(container?.querySelector('form[aria-label="Edit README.md"]')).toBeNull()
})

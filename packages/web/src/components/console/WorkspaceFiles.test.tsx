// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mobile = vi.hoisted(() => ({ value: false }))
const workspace = vi.hoisted(() => ({
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
      exists: true,
      nextCursor: null
    })
  ),
  fetchWorkspaceGitStatus: vi.fn(() => Promise.resolve({ isRepo: false })),
  writeWorkspaceFile: vi.fn(),
  workspaceGitPull: vi.fn()
}))
vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mobile.value }))

import { WorkspaceFiles, workspaceReadModelKey } from './WorkspaceFiles'
import { deleteWorkspaceFile, writeWorkspaceFile } from '@/lib/api'
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
  workspace.entries = []
  workspace.listings = {}
  vi.mocked(deleteWorkspaceFile).mockClear()
  vi.mocked(writeWorkspaceFile).mockClear()
})

it('uses configured edit access even before runtime Git status loads', () => {
  const html = renderToStaticMarkup(
    <WorkspaceFiles agentId="agent-a" workdir="/workspace" canEdit renderHeader={() => null} />
  )
  expect(html).toContain('Add file')
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

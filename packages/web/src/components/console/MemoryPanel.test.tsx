// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ updateAgent: vi.fn() }))

vi.mock('next/dynamic', () => ({ default: () => () => null }))

vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ updateAgent: mocks.updateAgent })
}))

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {
    status = 500
  },
  fetchAgentMemoryFull: vi.fn(),
  listAgentMemory: vi.fn(),
  updateAgentMemory: vi.fn()
}))

vi.mock('@/components/console/ExternalMemoryBindingFields', () => ({
  DEFAULT_EXTERNAL_MEMORY_BINDING: {
    connectionId: '',
    recall: { mode: 'auto', topK: 5, maxBytes: 8192, timeoutMs: 3000 },
    captureMode: 'manual'
  },
  ExternalMemoryBindingFields: () => null
}))

vi.mock('@/components/console/FileBrowser', () => ({
  FileBrowserShell: ({ children }: { children: ReactNode }) => <div data-testid="file-memory-view">{children}</div>,
  FileBrowserLayout: () => null,
  FileBrowserPreviewHeader: () => null,
  FileBrowserRow: () => null
}))

vi.mock('@/components/console/RecordMemoryPanel', () => ({
  RecordMemoryPanel: () => <div data-testid="record-memory-view" />
}))

import { MemoryPanel } from './MemoryPanel'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const recallPolicy = () => ({
  mode: 'auto' as const,
  topK: 5,
  maxBytes: 8192,
  timeoutMs: 3000
})

describe('MemoryPanel settings draft', () => {
  it('shows the fixed agent scope and explains that memory is shared across users', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MemoryPanel
          agentId="22222222-2222-4222-8222-222222222222"
          canEdit
          memoryProvider="managed"
          autoDistill={false}
        />
      )
    })

    const scope = container.querySelector<HTMLButtonElement>('[data-memory-scope="agent"]')
    expect(scope?.textContent).toBe('Agent')
    expect(scope?.disabled).toBe(true)

    const help = container.querySelector<HTMLButtonElement>('[aria-label="About agent memory scope"]')
    const tooltipId = help?.getAttribute('aria-describedby')
    expect(tooltipId).toBeTruthy()
    const tooltip = tooltipId ? container.querySelector<HTMLElement>(`#${tooltipId}`) : null
    expect(tooltip?.getAttribute('role')).toBe('tooltip')
    expect(tooltip?.textContent).toContain('Memory is shared across all users who interact with this agent.')
  })

  it('hides the persisted memory session while a different backend is selected but unsaved', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MemoryPanel
          agentId="22222222-2222-4222-8222-222222222222"
          canEdit
          memoryProvider="managed"
          autoDistill={false}
        />
      )
    })

    expect(container.querySelector('[data-testid="file-memory-view"]')).not.toBeNull()
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[data-memory-provider="external"]')?.click()
    })

    expect(container.querySelector('[data-testid="file-memory-view"]')).toBeNull()
    expect(container.querySelector('[data-testid="record-memory-view"]')).toBeNull()
    expect(container.textContent).toContain('Save memory settings to switch to External and view its memory.')

    const discardButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Discard changes'
    )
    await act(async () => discardButton?.click())

    expect(container.querySelector('[data-testid="file-memory-view"]')).not.toBeNull()
  })

  it('preserves unsaved edits when refreshed props contain an equivalent recall object', async () => {
    const props = {
      agentId: '22222222-2222-4222-8222-222222222222',
      canEdit: true,
      memoryProvider: 'external',
      autoDistill: false,
      memoryConnectionId: CONNECTION_ID,
      memoryCaptureMode: 'manual' as const
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryRecall={recallPolicy()} />)
    })

    const nativeButton = container.querySelector<HTMLButtonElement>('[data-memory-provider="native"]')
    expect(nativeButton).not.toBeNull()
    await act(async () => {
      nativeButton?.click()
    })
    expect(nativeButton?.className).toContain('pill on')

    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryRecall={recallPolicy()} />)
    })

    expect(nativeButton?.className).toContain('pill on')

    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryRecall={{ ...recallPolicy(), topK: 6 }} />)
    })

    expect(nativeButton?.className).not.toContain('pill on')
    expect(container.querySelector<HTMLButtonElement>('[data-memory-provider="external"]')?.className).toContain(
      'pill on'
    )
  })

  it('uses an app confirmation before persisting a backend switch', async () => {
    const nativeConfirm = vi.fn(() => true)
    vi.stubGlobal('confirm', nativeConfirm)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MemoryPanel
          agentId="22222222-2222-4222-8222-222222222222"
          canEdit
          memoryProvider="managed"
          autoDistill={false}
        />
      )
    })

    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[data-memory-provider="native"]')?.click()
    })
    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save memory settings'
    )
    await act(async () => saveButton?.click())

    expect(nativeConfirm).not.toHaveBeenCalled()
    expect(mocks.updateAgent).not.toHaveBeenCalled()
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]')
    expect(dialog?.textContent).toContain('Switch memory backend')

    const confirmButton = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Switch backend'
    )
    await act(async () => confirmButton?.click())

    expect(mocks.updateAgent).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', {
      memory: { provider: 'native', autoDistill: false }
    })
  })
})

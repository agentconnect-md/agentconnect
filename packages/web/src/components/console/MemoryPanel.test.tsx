// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ updateAgent: vi.fn(), isMobile: false }))

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

vi.mock('@/components/console/FileBrowser', async () => {
  const actual = await vi.importActual<typeof import('@/components/console/FileBrowser')>(
    '@/components/console/FileBrowser'
  )
  return {
    ...actual,
    FileBrowserShell: (props: { title: ReactNode; headerEnd?: ReactNode; children: ReactNode }) => (
      <div data-testid="file-memory-view">
        <actual.FileBrowserShell {...props} />
      </div>
    )
  }
})

vi.mock('@/lib/use-is-mobile', () => ({ useIsMobile: () => mocks.isMobile }))

vi.mock('@/components/console/RecordMemoryPanel', () => ({
  RecordMemoryPanel: () => <div data-testid="record-memory-view" />
}))

vi.mock('@/components/console/DreamPanel', () => ({
  DreamPanel: () => <div data-testid="dream-memory-view" />
}))

vi.mock('@/components/console/ManagedMemoryHistory', () => ({
  ManagedMemoryHistory: () => <div data-testid="memory-file-history" />
}))

import { fetchAgentMemoryFull, listAgentMemory, updateAgentMemory } from '@/lib/api'
import { MemoryPanel } from './MemoryPanel'

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  mocks.updateAgent.mockReset().mockResolvedValue(undefined)
  mocks.isMobile = false
  vi.mocked(listAgentMemory)
    .mockReset()
    .mockResolvedValue({
      exists: true,
      files: [{ name: 'MEMORY.md', size: 9, mtime: '2026-07-27T09:00:00.000Z' }]
    })
  vi.mocked(fetchAgentMemoryFull)
    .mockReset()
    .mockResolvedValue({ exists: true, content: '# Memory', mtime: '2026-07-27T09:00:00.000Z' })
  vi.mocked(updateAgentMemory)
    .mockReset()
    .mockResolvedValue({ path: 'MEMORY.md', size: 9, mtime: '2026-07-27T09:01:00.000Z' })
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

/** The settings form is collapsed behind the summary bar; expand it. */
const openSettings = async (host: HTMLElement) => {
  const editButton = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Edit')
  expect(editButton).toBeTruthy()
  await act(async () => editButton?.click())
}

const clickButton = async (host: HTMLElement, label: string) => {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button, `${label} button`).toBeTruthy()
  await act(async () => button?.click())
}

const changeValue = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('MemoryPanel file editor', () => {
  it('places History in the shared file summary row', async () => {
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
      await Promise.resolve()
    })

    const history = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.trim() === 'History'
    )
    const summary = history?.closest('.h-\\[37px\\]')
    expect(summary?.textContent).toContain('9 B')
    expect(summary?.querySelector('button')).toBe(history)
    expect(container.querySelector('[data-testid="memory-file-history"]')).toBeNull()

    await act(async () => history?.click())
    expect(container.querySelector('[data-testid="memory-file-history"]')).not.toBeNull()
  })

  it('uses the shared inline add flow instead of a browser prompt', async () => {
    const prompt = vi.fn(() => 'legacy.md')
    vi.stubGlobal('prompt', prompt)
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
      await Promise.resolve()
    })

    await clickButton(container, 'Add file')
    expect(prompt).not.toHaveBeenCalled()

    const name = container.querySelector<HTMLInputElement>('input[aria-label="New memory file name"]')
    const content = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="New file content"]')
    expect(name?.closest('.cardhead')).not.toBeNull()
    expect(content?.closest('.card')).not.toBeNull()

    await changeValue(name!, 'deploys.md')
    await changeValue(content!, '# Deploys')
    await clickButton(container, 'Save changes')

    expect(updateAgentMemory).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      '# Deploys',
      'deploys.md',
      undefined
    )
  })

  it('returns mobile editing to the file list only from the breadcrumb back action', async () => {
    mocks.isMobile = true
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
      await Promise.resolve()
    })

    const memory = container.querySelector<HTMLElement>('[data-testid="file-memory-view"]')!
    const tree = memory.querySelector<HTMLElement>('[data-file-browser-pane="tree"]')!
    const preview = memory.querySelector<HTMLElement>('[data-file-browser-pane="preview"]')!
    await clickButton(tree, 'MEMORY.md')
    expect(tree.classList.contains('hidden')).toBe(true)
    expect(preview.classList.contains('flex')).toBe(true)

    await clickButton(memory, 'Edit')
    await clickButton(memory, 'Cancel')
    expect(tree.classList.contains('hidden')).toBe(true)
    expect(preview.classList.contains('flex')).toBe(true)

    await clickButton(memory, 'Edit')
    const back = memory.querySelector<HTMLButtonElement>('button[aria-label="Back to files"]')
    expect(back).not.toBeNull()
    await act(async () => back?.click())
    expect(tree.classList.contains('block')).toBe(true)
    expect(preview.classList.contains('hidden')).toBe(true)
  })
})

describe('MemoryPanel settings draft', () => {
  it('defaults managed memory to daily dreaming and lets users opt in to automatic acceptance', async () => {
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

    await openSettings(container)
    const checkboxFor = (text: string) =>
      [...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
        box.parentElement?.textContent?.includes(text)
      )

    expect(checkboxFor('Enable dreaming')?.checked).toBe(true)
    expect(checkboxFor('Run on a schedule')?.checked).toBe(true)
    expect(checkboxFor('Automatically adopt completed memory results')?.checked).toBe(false)
    expect(container.textContent).toContain('Daily')
    expect(container.textContent).not.toContain('Dream memory results can be inaccurate')

    await act(async () => checkboxFor('Automatically adopt completed memory results')?.click())
    expect(container.textContent).toContain('Dream memory results can be inaccurate')
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save memory settings'
    )
    await act(async () => save?.click())

    expect(mocks.updateAgent).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', {
      memory: {
        provider: 'managed',
        autoDistill: false,
        dreaming: { enabled: true, schedule: '0 4 * * *', autoAdopt: true }
      }
    })
  })

  // Skill mining is off unless the policy says otherwise, and the daemon keys
  // three separate things off that one flag (the extract-procedures phase, the
  // tool rows in the prompt, and the grounding set). Without a control here it
  // could never be turned on, so a dream would silently mine nothing forever.
  it('turns skill mining on and sends it with the memory binding', async () => {
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

    await openSettings(container)
    const checkboxFor = (text: string) =>
      [...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
        box.parentElement?.textContent?.includes(text)
      )

    expect(checkboxFor('Also mine reusable skills')?.checked).toBe(false)
    expect(container.textContent).not.toContain('at least two sessions')

    await act(async () => checkboxFor('Also mine reusable skills')?.click())
    expect(container.textContent).toContain('at least two sessions')

    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Save memory settings'
    )
    await act(async () => save?.click())

    expect(mocks.updateAgent).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', {
      memory: {
        provider: 'managed',
        autoDistill: false,
        dreaming: { enabled: true, schedule: '0 4 * * *', autoAdopt: false, mineSkills: true }
      }
    })
  })

  it('collapses the settings form behind a summary of the persisted backend', async () => {
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

    // Collapsed: no provider picker, but the summary names the active backend
    // and scope; the persisted memory content is shown.
    expect(container.querySelector('[data-memory-provider="managed"]')).toBeNull()
    expect(container.textContent).toContain('Managed')
    expect(container.textContent).toContain('Dreaming daily')
    expect(container.textContent).toContain('Auto-accept off')
    expect(container.textContent).toContain('Agent scope')
    expect(container.querySelector('[data-testid="file-memory-view"]')).not.toBeNull()

    await openSettings(container)
    expect(container.querySelector('[data-memory-provider="managed"]')).not.toBeNull()

    // Closing without changes collapses it again.
    const closeButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Close'
    )
    await act(async () => closeButton?.click())
    expect(container.querySelector('[data-memory-provider="managed"]')).toBeNull()
  })

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

    await openSettings(container)
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
    await openSettings(container)
    await act(async () => {
      container?.querySelector<HTMLButtonElement>('[data-memory-provider="external"]')?.click()
    })

    expect(container.querySelector('[data-testid="file-memory-view"]')).toBeNull()
    expect(container.querySelector('[data-testid="record-memory-view"]')).toBeNull()
    expect(container.textContent).toContain('Save memory settings to switch to External and view its memory.')

    const cancelButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => cancelButton?.click())

    expect(container.querySelector('[data-testid="file-memory-view"]')).not.toBeNull()
    // Cancelling also collapses the form back to the summary bar.
    expect(container.querySelector('[data-memory-provider="external"]')).toBeNull()
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

    await openSettings(container)
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

  it('keeps a persisted dreaming policy across mount and equivalent prop refreshes', async () => {
    // Regression: the prop-sync effect must carry `memoryDreaming` (otherwise an
    // enabled policy renders as off right after mount and a later save erases
    // it), and must compare the policy's semantic fields — polling hands us a new
    // object every refresh, which must not clobber an in-progress draft.
    const dreaming = () => ({ enabled: true, sessionWindow: 40, instructions: 'focus on prefs' })
    const props = {
      agentId: '33333333-3333-4333-8333-333333333333',
      canEdit: true,
      memoryProvider: 'managed',
      autoDistill: false
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryDreaming={dreaming()} />)
    })

    await openSettings(container)
    const dreamingBox = () =>
      [...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
        box.parentElement?.textContent?.includes('Enable dreaming')
      )
    // Survives the mount effect rather than resetting to "Dreaming off".
    expect(dreamingBox()?.checked).toBe(true)

    // An equivalent (re-created) policy object must not reset the toggle.
    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryDreaming={dreaming()} />)
    })
    expect(dreamingBox()?.checked).toBe(true)

    // A genuine change in a semantic field does re-sync.
    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryDreaming={{ ...dreaming(), enabled: false }} />)
    })
    expect(dreamingBox()?.checked).toBe(false)
  })

  it('places dreaming below the live memory browser', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <MemoryPanel
          agentId="33333333-3333-4333-8333-333333333333"
          canEdit
          memoryProvider="managed"
          autoDistill={false}
          memoryDreaming={{ enabled: true }}
        />
      )
    })

    const memory = container.querySelector('[data-testid="file-memory-view"]')
    const dreaming = container.querySelector('[data-testid="dream-memory-view"]')
    expect(memory).not.toBeNull()
    expect(dreaming).not.toBeNull()
    if (!memory || !dreaming) throw new Error('Expected memory and dreaming panels')
    expect(memory.compareDocumentPosition(dreaming) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(dreaming.parentElement?.className).toContain('mt-4')
  })

  it('resyncs on a timezone-only refresh, so a later save cannot restore the stale zone', async () => {
    // `timezone` is preserved through the wholesale memory PATCH but not edited
    // in the UI. If it were missing from the prop-sync dependency list, a
    // timezone-only poll would leave the draft on the old zone and the next
    // unrelated edit would silently write it back.
    const props = {
      agentId: '44444444-4444-4444-8444-444444444444',
      canEdit: true,
      memoryProvider: 'managed',
      autoDistill: false
    }
    const policy = (timezone: string) => ({ enabled: true, schedule: '0 4 * * *', timezone })

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryDreaming={policy('UTC')} />)
    })
    await openSettings(container)

    // Only the timezone changes upstream.
    await act(async () => {
      root?.render(<MemoryPanel {...props} memoryDreaming={policy('America/New_York')} />)
    })

    // An unrelated edit (auto-distill) then saves the WHOLE binding.
    const distillBox = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
      box.parentElement?.textContent?.includes('Automatically distill')
    )
    await act(async () => {
      distillBox?.click()
    })
    const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Save memory settings'
    )
    await act(async () => {
      save?.click()
    })

    const saved = mocks.updateAgent.mock.calls.at(-1)?.[1] as
      { memory?: { dreaming?: { timezone?: string } } } | undefined
    expect(saved?.memory?.dreaming?.timezone).toBe('America/New_York')
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

    await openSettings(container)
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
    // A successful save collapses the form back to the summary bar.
    expect(container.querySelector('[data-memory-provider="native"]')).toBeNull()
  })
})

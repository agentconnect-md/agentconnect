// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMcpToolPolicyDto, McpCatalogToolDto, McpToolCatalogDto } from '@/lib/api'

const api = vi.hoisted(() => ({
  fetchMcpToolCatalog: vi.fn(),
  refreshMcpToolCatalog: vi.fn(),
  saveAgentMcpToolPolicy: vi.fn(),
  deleteAgentMcpToolPolicy: vi.fn()
}))
vi.mock('@/lib/api', () => api)

import { McpToolPermissionsPanel, type ToolPolicyCompatibility } from './McpToolPermissionsPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const TOOLS: McpCatalogToolDto[] = [
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'Lists issues.',
    readOnlyHint: true,
    interactive: false,
    group: 'readOnly'
  },
  { name: 'delete_issue', description: 'Deletes an issue.', readOnlyHint: false, interactive: false, group: 'write' },
  { name: 'edit_issue', readOnlyHint: false, destructiveHint: false, interactive: false, group: 'write' },
  { name: 'open_board', description: 'x'.repeat(200), interactive: true, group: 'other' }
]

const catalog = (over: Partial<McpToolCatalogDto> = {}): McpToolCatalogDto => ({
  tools: TOOLS,
  groups: { readOnly: 1, write: 2, other: 1 },
  fetchedAt: new Date(Date.now() - 60_000).toISOString(),
  failure: null,
  ...over
})

const policy = (over: Partial<AgentMcpToolPolicyDto> = {}): AgentMcpToolPolicyDto => ({
  providerId: 'p1',
  providerName: 'linear',
  groups: { readOnly: 'allow', write: 'block', other: 'block' },
  overrides: {},
  allowTools: ['list_issues'],
  approvalTools: [],
  askTools: [],
  catalogFetchedAt: null,
  updatedBy: null,
  updatedAt: new Date().toISOString(),
  drift: null,
  ...over
})

let host: HTMLDivElement | undefined
let root: Root | undefined
const onSaved = vi.fn()
const onClose = vi.fn()

async function render(
  saved: AgentMcpToolPolicyDto | null,
  compatibility: ToolPolicyCompatibility | null = null
): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <McpToolPermissionsPanel
        agentId="a1"
        providerId="p1"
        providerName="linear"
        policy={saved}
        compatibility={compatibility}
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  })
  return host
}

const click = (el: Element | null | undefined) =>
  act(async () => {
    expect(el).toBeTruthy()
    ;(el as HTMLElement).click()
  })

const buttonByText = (text: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

/** Open a FieldSelect by its aria-label and return its options. */
async function openSelect(label: string): Promise<HTMLButtonElement[]> {
  await click(document.querySelector(`button[aria-label="${label}"]`))
  return [...document.querySelectorAll<HTMLButtonElement>('[data-anchored-flyout] [role="menuitemradio"]')]
}

async function pick(label: string, option: string) {
  const options = await openSelect(label)
  await click(options.find((o) => o.textContent?.startsWith(option)))
}

const save = () => click(buttonByText('Save'))

beforeEach(() => {
  api.fetchMcpToolCatalog.mockResolvedValue(catalog())
  api.refreshMcpToolCatalog.mockResolvedValue(catalog())
  api.saveAgentMcpToolPolicy.mockResolvedValue(policy())
  api.deleteAgentMcpToolPolicy.mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
  host = undefined
  vi.clearAllMocks()
})

describe('McpToolPermissionsPanel presets and decisions', () => {
  it('applies the Read-only preset and saves its groups', async () => {
    await render(null)
    expect(buttonByText('Save')?.disabled).toBe(true)
    await click(buttonByText('Read-only'))
    await save()
    expect(api.saveAgentMcpToolPolicy).toHaveBeenCalledWith('a1', 'p1', {
      groups: { readOnly: 'allow', write: 'block', other: 'block' },
      overrides: {}
    })
    expect(onSaved).toHaveBeenCalled()
  })

  it('resolves a tool to its group until overridden, and saves the override with the groups', async () => {
    const view = await render(policy())
    expect(buttonByText('Read-only')?.getAttribute('aria-checked')).toBe('true')
    await click(view.querySelector('[data-testid="tool-group-write"] button[aria-expanded]'))
    const trigger = view.querySelector('button[aria-label="Decision for delete_issue"]')
    expect(trigger?.textContent).toContain('Follows group')
    expect(trigger?.textContent).toContain('Blocked')

    await pick('Decision for delete_issue', 'Always allow')
    expect(view.querySelector('button[aria-label="Decision for delete_issue"]')?.textContent).toContain('Always allow')
    expect(buttonByText('Custom')?.getAttribute('aria-checked')).toBe('true')
    await pick('Decision for Other tools', 'Always allow')
    await save()
    expect(api.saveAgentMcpToolPolicy).toHaveBeenCalledWith('a1', 'p1', {
      groups: { readOnly: 'allow', write: 'block', other: 'allow' },
      overrides: { delete_issue: 'allow' }
    })
  })

  it('drops an override when the tool goes back to following its group', async () => {
    const view = await render(policy({ overrides: { delete_issue: 'allow' } }))
    expect(buttonByText('Custom')?.getAttribute('aria-checked')).toBe('true')
    expect(view.querySelector('[data-testid="tool-group-write"]')?.textContent).toContain('1 overridden')
    await click(view.querySelector('[data-testid="tool-group-write"] button[aria-expanded]'))
    await pick('Decision for delete_issue', 'Follows group')
    await save()
    expect(api.saveAgentMcpToolPolicy).toHaveBeenCalledWith('a1', 'p1', {
      groups: { readOnly: 'allow', write: 'block', other: 'block' },
      overrides: {}
    })
  })

  it('offers the approval decisions disabled until approvals ship', async () => {
    await render(policy())
    const options = await openSelect('Decision for Write/delete tools')
    const byLabel = (label: string) => options.find((o) => o.textContent?.startsWith(label))!
    expect(byLabel('Always allow').disabled).toBe(false)
    expect(byLabel('Blocked').disabled).toBe(false)
    expect(byLabel('Needs approval').disabled).toBe(true)
    expect(byLabel('Always ask').disabled).toBe(true)
    expect(byLabel('Needs approval').textContent).toContain('Available when approvals ship.')
    expect(byLabel('Always ask').textContent).toContain(
      'A person approves each use, even in a mode with automatic review.'
    )
  })

  it('badges interactive and destructive tools, and excerpts long descriptions', async () => {
    const view = await render(policy())
    await click(view.querySelector('[data-testid="tool-group-write"] button[aria-expanded]'))
    await click(view.querySelector('[data-testid="tool-group-other"] button[aria-expanded]'))
    expect(view.querySelector('[data-testid="tool-row-delete_issue"]')?.textContent).toContain('Destructive')
    expect(view.querySelector('[data-testid="tool-row-edit_issue"]')?.textContent).not.toContain('Destructive')
    const board = view.querySelector('[data-testid="tool-row-open_board"]')!
    expect(board.textContent).toContain('Interactive')
    expect(board.textContent).not.toContain('x'.repeat(200))
    await click(buttonByText('Show more', board))
    expect(board.textContent).toContain('x'.repeat(200))
  })

  it('returns to Full access after confirming', async () => {
    await render(policy())
    await click(buttonByText('Return to Full access'))
    expect(api.deleteAgentMcpToolPolicy).not.toHaveBeenCalled()
    const strip = document.querySelector('[role="group"]')!
    await click(buttonByText('Return to Full access', strip))
    expect(api.deleteAgentMcpToolPolicy).toHaveBeenCalledWith('a1', 'p1')
    expect(onSaved).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('McpToolPermissionsPanel catalog', () => {
  it('refreshes a never-listed catalog once when it opens', async () => {
    api.fetchMcpToolCatalog.mockResolvedValue(catalog({ fetchedAt: null, tools: [] }))
    api.refreshMcpToolCatalog.mockResolvedValue(catalog({ fetchedAt: null, tools: [], failure: 'timeout' }))
    await render(null)
    expect(api.refreshMcpToolCatalog).toHaveBeenCalledTimes(1)
  })

  it('refreshes a catalog listed over a day ago, and leaves a fresh one alone', async () => {
    api.fetchMcpToolCatalog.mockResolvedValue(
      catalog({ fetchedAt: new Date(Date.now() - 25 * 3600_000).toISOString() })
    )
    await render(null)
    expect(api.refreshMcpToolCatalog).toHaveBeenCalledTimes(1)
    act(() => root?.unmount())
    vi.clearAllMocks()
    api.fetchMcpToolCatalog.mockResolvedValue(catalog())
    const view = await render(null)
    expect(api.refreshMcpToolCatalog).not.toHaveBeenCalled()
    expect(view.querySelector('[data-testid="tool-catalog-status"]')?.textContent).toMatch(/^Tools listed /)
  })

  it('maps failure codes to a message', async () => {
    api.fetchMcpToolCatalog.mockResolvedValue(catalog({ failure: 'blocked_address' }))
    const view = await render(null)
    expect(view.querySelector('[data-testid="tool-catalog-failure"]')?.textContent).toBe(
      "The last refresh failed: The server's address is blocked by the relay's network policy."
    )
    act(() => root?.unmount())
    api.fetchMcpToolCatalog.mockResolvedValue(catalog({ failure: 'relay_unavailable' }))
    expect((await render(null)).querySelector('[data-testid="tool-catalog-failure"]')?.textContent).toContain(
      'No relay that can list tools is connected.'
    )
    act(() => root?.unmount())
    api.fetchMcpToolCatalog.mockResolvedValue(catalog({ failure: 'something_new' }))
    expect((await render(null)).querySelector('[data-testid="tool-catalog-failure"]')?.textContent).toContain(
      'Listing tools failed (something_new).'
    )
  })

  it('lets a person name tools by hand without a catalog, offering only allow and block', async () => {
    api.fetchMcpToolCatalog.mockResolvedValue(catalog({ tools: [], groups: { readOnly: 0, write: 0, other: 0 } }))
    api.refreshMcpToolCatalog.mockResolvedValue(catalog({ tools: [], failure: 'unreachable' }))
    const view = await render(null)
    expect(view.textContent).toContain('Group settings apply once the tool list is available')
    await click(buttonByText('Read-only'))
    const input = view.querySelector<HTMLInputElement>('input[aria-label="Tools named by hand"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'search_docs')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttonByText('Add tool'))
    const options = await openSelect('Decision for search_docs')
    expect(options.filter((o) => !o.disabled).map((o) => o.textContent?.split('The ')[0])).toEqual([
      'Always allow',
      'Blocked'
    ])
    expect(options).toHaveLength(2)
    await click(options[0])
    await save()
    expect(api.saveAgentMcpToolPolicy).toHaveBeenCalledWith('a1', 'p1', {
      groups: { readOnly: 'allow', write: 'block', other: 'block' },
      overrides: { search_docs: 'allow' }
    })
  })
})

describe('McpToolPermissionsPanel warnings', () => {
  it('shows the drift banner for new, changed and missing tools', async () => {
    const view = await render(
      policy({ drift: { newTools: ['a', 'b', 'c'], changedTools: ['d'], missingTools: ['e', 'f'] } })
    )
    const banner = view.querySelector('[data-testid="tool-policy-drift"]')?.textContent
    expect(banner).toContain('3 new tools are blocked until you review them.')
    expect(banner).toContain('1 tool now has a different decision')
    expect(banner).toContain('2 saved tools are no longer listed by the server.')
  })

  it('shows no drift banner when nothing drifted', async () => {
    const view = await render(policy({ drift: { newTools: [], changedTools: [], missingTools: [] } }))
    expect(view.querySelector('[data-testid="tool-policy-drift"]')).toBeNull()
  })

  it('warns about peers that cannot enforce a restriction, only while restricted', async () => {
    const compat = { daemonsWithoutAgentDefinitions: ['old-mac'], relaysWithoutToolPolicies: 2 }
    const view = await render(policy(), compat)
    expect(view.textContent).toContain('1 daemon serving this agent cannot attach a restricted server (old-mac).')
    expect(view.textContent).toContain('2 connected relays do not support tool permissions yet.')
    await click(buttonByText('Full access'))
    expect(view.textContent).not.toContain('old-mac')
    expect(view.textContent).not.toContain('connected relays')
  })
})

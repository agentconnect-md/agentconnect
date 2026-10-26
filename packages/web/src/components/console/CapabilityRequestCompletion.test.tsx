// @vitest-environment happy-dom
// Completing a capability request saves through the console's own dialog or route, prefilled, and settles only after a save landed.
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRequestDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const mocks = vi.hoisted(() => ({
  settle: vi.fn(),
  fetchAgent: vi.fn(),
  updateAgent: vi.fn(),
  editProps: undefined as Record<string, unknown> | undefined,
  skillSources: [] as Array<{ name: string }>
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: 'agent-1', name: 'pilot', runtime: 'claude-acp', daemon: 'd-1', canEdit: true }],
    daemons: [],
    skillSources: mocks.skillSources,
    updateAgent: mocks.updateAgent
  })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  settleCapabilityRequest: mocks.settle,
  fetchAgentDto: mocks.fetchAgent
}))
vi.mock('@/components/console/Scrim', () => ({ Scrim: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/console/modals/EditAgentModal', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.editProps = props
    return <div data-edit-agent />
  }
}))
vi.mock('@/components/console/AgentToolsCard', () => ({ AgentToolsCard: () => <div data-tools-card /> }))
vi.mock('@/components/console/AgentSkillsCard', () => ({ AgentSkillsCard: () => <div data-skills-card /> }))
vi.mock('@/components/console/InstallRegistrySkillModal', () => ({
  InstallRegistrySkillModal: ({ initialQuery }: { initialQuery?: string }) => <div data-registry={initialQuery} />
}))

const { CapabilityRequestCompletion } = await import('./CapabilityRequestCompletion')

function request(overrides: Partial<CapabilityRequestDto>): CapabilityRequestDto {
  return {
    id: 'req-1',
    orgId: 'org-1',
    agentId: 'agent-1',
    agentName: 'pilot',
    kind: 'agent-settings',
    target: 'model',
    want: { model: 'opus' },
    summary: '',
    reason: '',
    status: 'open',
    generation: 1,
    createdAt: '2026-10-26T09:00:00.000Z',
    expiresAt: '2026-11-02T09:00:00.000Z',
    settledAt: null,
    settledBy: null,
    outcome: null,
    differs: false,
    note: null,
    origins: [],
    current: {},
    warnings: [],
    viewer: { canComplete: true, canDecline: true, canReopen: false, canForward: false, missing: null, whoCan: [] },
    ...overrides
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined
const onSettled = vi.fn()

async function render(dto: CapabilityRequestDto): Promise<HTMLDivElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(<CapabilityRequestCompletion request={dto} onSettled={onSettled} />))
  return host
}

const button = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined

beforeEach(() => {
  mocks.settle.mockReset()
  mocks.fetchAgent.mockReset()
  mocks.updateAgent.mockReset()
  mocks.editProps = undefined
  mocks.skillSources = []
  onSettled.mockReset()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

describe('completing a capability request', () => {
  it('opens the agent configuration dialog on its runtime settings, prefilled, and settles once it saved', async () => {
    const settled = request({ status: 'completed' })
    mocks.settle.mockResolvedValue(settled)
    const scope = await render(request({ want: { model: 'opus', fastMode: true } }))
    expect(scope.querySelector('[data-edit-agent]')).toBeNull()
    await act(async () => button(scope, 'Review and save settings')!.click())
    expect(scope.querySelector('[data-edit-agent]')).not.toBeNull()
    expect(mocks.editProps).toMatchObject({ focusSection: 'runtime', prefill: { model: 'opus', fastMode: true } })
    expect(mocks.settle).not.toHaveBeenCalled()
    await act(async () => (mocks.editProps!.onSaved as () => void)())
    expect(mocks.settle).toHaveBeenCalledWith('req-1', 'org-1')
    expect(onSettled).toHaveBeenCalledWith(settled)
  })

  it('attaches the server beside the agent’s others, then settles', async () => {
    mocks.fetchAgent.mockResolvedValue({ mcpServers: ['grafana'], skills: [] })
    mocks.updateAgent.mockResolvedValue(undefined)
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(
      request({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: true } })
    )
    await act(async () => button(scope, 'Add Linear')!.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { mcpServers: ['grafana', 'Linear'] })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
  })

  it('does not settle when the save was refused', async () => {
    mocks.fetchAgent.mockResolvedValue({ mcpServers: [], skills: [] })
    mocks.updateAgent.mockRejectedValue(new Error('not an editor'))
    const scope = await render(
      request({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: true } })
    )
    await act(async () => button(scope, 'Add Linear')!.click())
    expect(mocks.settle).not.toHaveBeenCalled()
    expect(scope.querySelector('[role="alert"]')?.textContent).toBe('not an editor')
  })

  it('points to Tools & Skills for a server the organization never registered', async () => {
    const scope = await render(
      request({ kind: 'mcp-server', want: { server: 'Linear' }, current: { attached: false, exists: false } })
    )
    expect(button(scope, 'Add Linear')).toBeUndefined()
    expect(scope.querySelector('a[href="/acme/tools"]')).not.toBeNull()
  })

  it('enables a skill from a source in the library, and searches the registry otherwise', async () => {
    mocks.skillSources = [{ name: 'acme' }]
    mocks.fetchAgent.mockResolvedValue({ mcpServers: [], skills: ['other/*'] })
    mocks.updateAgent.mockResolvedValue(undefined)
    mocks.settle.mockResolvedValue(request({ status: 'completed' }))
    const scope = await render(request({ kind: 'skill', want: { skill: 'acme/lint' }, current: { installed: false } }))
    await act(async () => button(scope, 'Install acme/lint')!.click())
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', { skills: ['other/*', 'acme/lint'] })
    expect(mocks.settle).toHaveBeenCalledTimes(1)
    await act(async () => root!.unmount())
    host?.remove()

    mocks.skillSources = []
    const fresh = await render(request({ kind: 'skill', want: { skill: 'acme/lint' }, current: { installed: false } }))
    expect(fresh.textContent).toContain('The skill library has no source named acme yet.')
    await act(async () => button(fresh, 'Find it in the skill registry')!.click())
    expect(fresh.querySelector('[data-registry]')?.getAttribute('data-registry')).toBe('lint')
  })
})

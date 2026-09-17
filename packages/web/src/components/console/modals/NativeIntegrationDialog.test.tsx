// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SETUP_URI,
  AGENT_TOOLS_URI,
  CODE_HOST_SETUP_URI,
  INTEGRATION_SETUP_URI,
  MCP_SETUP_URI,
  SKILL_SETUP_URI,
  type NativeMcpUi
} from '@agentconnect.md/protocol/mcp-app'
import NativeIntegrationDialog from './NativeIntegrationDialog'
vi.mock('../platforms/registry', () => ({ channelListSemantics: () => ({}) }))

const mocks = vi.hoisted(() => ({
  orgId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  fetchAgentHooks: vi.fn(),
  updateGithubHook: vi.fn(),
  updateGitlabHook: vi.fn(),
  updateGiteaHook: vi.fn(),
  updateIntegrationChannel: vi.fn(),
  refresh: vi.fn(),
  createProps: vi.fn()
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: mocks.orgId } }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: mocks.agentId, canEdit: true }],
    integrations: [],
    loading: false,
    refresh: mocks.refresh
  })
}))
vi.mock('@/lib/api', () => ({
  fetchAgentHooks: mocks.fetchAgentHooks,
  fetchAgentRepos: async () => [],
  fetchGithubInstallations: async () => ({ installations: [] }),
  updateGithubHook: mocks.updateGithubHook,
  updateGitlabHook: mocks.updateGitlabHook,
  updateGiteaHook: mocks.updateGiteaHook,
  updateIntegrationChannel: mocks.updateIntegrationChannel
}))
vi.mock('./CodeHostSetupDialog', () => ({ default: () => <div>Code host surface</div> }))
vi.mock('./AgentSetupDialog', () => ({ default: () => <div>Agent editor</div> }))
vi.mock('./AgentToolsDialog', () => ({ default: () => <div>Tools roster</div> }))
vi.mock('./SkillSetupDialog', () => ({ default: () => <div>Skill installer</div> }))
vi.mock('./McpSetupDialog', () => ({ default: () => <div>MCP installer</div> }))
vi.mock('./AddIntegrationModal', () => ({
  AddIntegrationForOrgModal: (props: unknown) => {
    mocks.createProps(props)
    return <div>Create wizard</div>
  }
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let element: HTMLDivElement
let root: ReturnType<typeof createRoot>
const hook = {
  id: '33333333-3333-4333-8333-333333333333',
  agentId: mocks.agentId,
  kind: 'github',
  name: 'Repository integration',
  repoFullName: 'acme/repo',
  family: 'pull_request',
  enabled: true,
  events: ['pull_request:reopened'],
  commentFamilies: [],
  mentionOnly: false,
  labelFilter: ['bug'],
  reviewPolicy: 'off',
  reportingMode: 'off',
  configRevision: '4'
}
type IntegrationUi = Extract<NativeMcpUi, { resourceUri: typeof INTEGRATION_SETUP_URI }>
function ui(intent: IntegrationUi['intent']): IntegrationUi {
  return { resourceUri: INTEGRATION_SETUP_URI, resourceVersion: 1, orgId: mocks.orgId, intent }
}
const edit = () => ui({ mode: 'edit', agentId: mocks.agentId, target: { kind: 'codehost-subscription', id: hook.id } })
const button = (label: string) => [...element.querySelectorAll('button')].find((item) => item.textContent === label)!
beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchAgentHooks.mockResolvedValue([hook])
  mocks.updateGithubHook.mockResolvedValue(hook)
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
})

describe('native integration dialog', () => {
  it('reuses the create wizard with the requested provider and agent, without creating anything on open', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(
        <NativeIntegrationDialog
          ui={ui({ mode: 'create', provider: 'github', agentId: mocks.agentId })}
          onClose={vi.fn()}
          onCompleted={completed}
        />
      )
    })
    expect(mocks.createProps).toHaveBeenCalledWith(
      expect.objectContaining({ initialPlatform: 'github', initialAgentId: mocks.agentId })
    )
    expect(completed).not.toHaveBeenCalled()
  })
  it('preserves custom subscription events when changing only enabled state and pins the write to the original organization', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(<NativeIntegrationDialog ui={edit()} onClose={vi.fn()} onCompleted={completed} />)
    })
    expect(mocks.updateGithubHook).not.toHaveBeenCalled()
    await act(async () => {
      element.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()
    })
    await act(async () => {
      button('Save changes').click()
    })
    expect(mocks.updateGithubHook).toHaveBeenCalledWith(
      hook.id,
      expect.objectContaining({
        enabled: false,
        events: hook.events,
        commentFamilies: [],
        labelFilter: hook.labelFilter
      }),
      mocks.orgId
    )
    expect(completed).toHaveBeenCalledOnce()
  })
  it('does not write on cancellation or report a changed target as saved', async () => {
    const completed = vi.fn()
    const close = vi.fn()
    await act(async () => {
      root.render(<NativeIntegrationDialog ui={edit()} onClose={close} onCompleted={completed} />)
    })
    await act(async () => {
      button('Cancel').click()
    })
    expect(close).toHaveBeenCalledOnce()
    expect(mocks.updateGithubHook).not.toHaveBeenCalled()
    mocks.fetchAgentHooks.mockResolvedValue([{ ...hook, configRevision: '5' }])
    await act(async () => {
      button('Save changes').click()
    })
    expect(mocks.updateGithubHook).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
    expect(element.textContent).toContain('This subscription changed')
  })
  it.each([
    [CODE_HOST_SETUP_URI, { provider: 'gitea' }, 'Code host surface'],
    [AGENT_SETUP_URI, { agentId: mocks.agentId }, 'Agent editor'],
    [SKILL_SETUP_URI, { source: 'registry' }, 'Skill installer'],
    [MCP_SETUP_URI, {}, 'MCP installer'],
    [AGENT_TOOLS_URI, { agentId: mocks.agentId }, 'Tools roster']
  ])('routes by the named resource, not by the intent’s shape (%s)', async (resourceUri, intent, shown) => {
    await act(async () =>
      root.render(
        <NativeIntegrationDialog
          ui={{ resourceUri, resourceVersion: 1, orgId: mocks.orgId, intent } as NativeMcpUi}
          onClose={vi.fn()}
          onCompleted={vi.fn()}
        />
      )
    )
    expect(element.textContent).toContain(shown)
    expect(mocks.createProps).not.toHaveBeenCalled()
  })

  it('refuses an organization mismatch before mounting a configuration editor', async () => {
    await act(async () => {
      root.render(
        <NativeIntegrationDialog ui={{ ...edit(), orgId: mocks.agentId }} onClose={vi.fn()} onCompleted={vi.fn()} />
      )
    })
    expect(mocks.fetchAgentHooks).not.toHaveBeenCalled()
    expect(element.textContent).toContain('another organization')
  })
})

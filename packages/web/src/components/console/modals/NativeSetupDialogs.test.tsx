// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_SETUP_URI,
  AGENT_TOOLS_URI,
  MCP_SETUP_URI,
  SKILL_SETUP_URI,
  type NativeMcpUi
} from '@agentconnect.md/protocol/mcp-app'
import AgentSetupDialog from './AgentSetupDialog'
import AgentToolsDialog from './AgentToolsDialog'
import SkillSetupDialog from './SkillSetupDialog'
import McpSetupDialog from './McpSetupDialog'

const mocks = vi.hoisted(() => ({
  orgId: '11111111-1111-4111-8111-111111111111',
  agentId: '22222222-2222-4222-8222-222222222222',
  role: 'admin' as string,
  canEdit: true,
  updateAgent: vi.fn(),
  refresh: vi.fn(),
  fetchAgentDto: vi.fn(),
  loading: false,
  editAgentProps: vi.fn(),
  toolsCardProps: vi.fn(),
  skillsCardProps: vi.fn(),
  registryProps: vi.fn(),
  gitProps: vi.fn(),
  mcpProps: vi.fn()
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: { id: mocks.orgId }, myRole: mocks.role })
}))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({
    agents: [{ id: mocks.agentId, name: 'my-agent', runtime: 'claude', daemon: 'd1', canEdit: mocks.canEdit }],
    daemons: [{ daemonId: 'd1', mcpServers: [], runtimeModels: [] }],
    skillSources: [],
    loading: mocks.loading,
    refresh: mocks.refresh,
    updateAgent: mocks.updateAgent
  })
}))
vi.mock('@/lib/api', () => ({ fetchAgentDto: mocks.fetchAgentDto }))
vi.mock('./EditAgentModal', () => ({
  default: (props: { onSaved?: () => void }) => {
    mocks.editAgentProps(props)
    return <button onClick={() => props.onSaved?.()}>Save agent</button>
  }
}))
vi.mock('@/components/console/InstallRegistrySkillModal', () => ({
  InstallRegistrySkillModal: (props: { initialQuery?: string; onCreated?: (s: unknown) => void }) => {
    mocks.registryProps(props)
    return <button onClick={() => props.onCreated?.({ name: 'runbooks' })}>Registry install</button>
  }
}))
vi.mock('@/components/console/SkillSourcesCard', () => ({
  CreateSkillSourceModal: (props: unknown) => {
    mocks.gitProps(props)
    return <div>Git import</div>
  }
}))
vi.mock('@/components/console/AgentToolsCard', () => ({
  AgentToolsCard: (props: { onBusyChange?: (busy: boolean) => void }) => {
    mocks.toolsCardProps(props)
    return <button onClick={() => props.onBusyChange?.(true)}>MCP roster saves</button>
  }
}))
vi.mock('@/components/console/AgentSkillsCard', () => ({
  AgentSkillsCard: (props: { onBusyChange?: (busy: boolean) => void }) => {
    mocks.skillsCardProps(props)
    return <button onClick={() => props.onBusyChange?.(true)}>Skills roster saves</button>
  }
}))
vi.mock('@/components/console/McpServersCard', () => ({
  CreateMcpProviderModal: (props: { onCreated?: (p: unknown) => void }) => {
    mocks.mcpProps(props)
    return <button onClick={() => props.onCreated?.({ name: 'linear' })}>Add server</button>
  }
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let element: HTMLDivElement
let root: ReturnType<typeof createRoot>
const skillUi = (intent: Record<string, unknown>) =>
  ({ resourceUri: SKILL_SETUP_URI, resourceVersion: 1, orgId: mocks.orgId, intent }) as NativeMcpUi & {
    resourceUri: typeof SKILL_SETUP_URI
  }
const mcpUi = (intent: Record<string, unknown>) =>
  ({ resourceUri: MCP_SETUP_URI, resourceVersion: 1, orgId: mocks.orgId, intent }) as NativeMcpUi & {
    resourceUri: typeof MCP_SETUP_URI
  }
const click = (label: string) =>
  [...element.querySelectorAll('button')].find((item) => item.textContent === label)!.click()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role = 'admin'
  mocks.canEdit = true
  mocks.loading = false
  mocks.updateAgent.mockResolvedValue(undefined)
  mocks.refresh.mockResolvedValue(undefined)
  mocks.fetchAgentDto.mockResolvedValue({ skills: ['other/*'], mcpServers: ['docs'] })
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
})

const agentUi = (intent: Record<string, unknown>) =>
  ({ resourceUri: AGENT_SETUP_URI, resourceVersion: 1, orgId: mocks.orgId, intent }) as NativeMcpUi & {
    resourceUri: typeof AGENT_SETUP_URI
  }

describe('native agent editor', () => {
  it('opens the console editor on the requested section and reports only a real save', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(
        <AgentSetupDialog
          ui={agentUi({ agentId: mocks.agentId, section: 'secrets', created: true })}
          onClose={vi.fn()}
          onCompleted={completed}
        />
      )
    })
    expect(mocks.editAgentProps).toHaveBeenCalledWith(expect.objectContaining({ focusSection: 'secrets' }))
    expect(completed).not.toHaveBeenCalled()
    await act(async () => click('Save agent'))
    expect(completed).toHaveBeenCalledWith('Saved the configuration of agent my-agent.')
  })

  it('waits for the console data instead of calling a still-unloaded agent missing', async () => {
    mocks.loading = true
    await act(async () => {
      root.render(<AgentSetupDialog ui={agentUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(element.textContent).toContain('Loading configuration')
    expect(mocks.editAgentProps).not.toHaveBeenCalled()
  })

  it('mounts no editor for an agent the reader cannot edit', async () => {
    mocks.canEdit = false
    await act(async () => {
      root.render(<AgentSetupDialog ui={agentUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(element.textContent).toContain('cannot edit this agent')
    expect(mocks.editAgentProps).not.toHaveBeenCalled()
  })

  it('revalidates the roster once before calling a just-created agent unavailable', async () => {
    const missing = '33333333-3333-4333-8333-333333333333'
    await act(async () => {
      root.render(<AgentSetupDialog ui={agentUi({ agentId: missing })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(mocks.refresh).toHaveBeenCalledOnce()
    // Only after that read comes back empty is the row genuinely gone.
    expect(element.textContent).toContain('unavailable')
    await act(async () => {
      root.render(<AgentSetupDialog ui={agentUi({ agentId: missing })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.editAgentProps).not.toHaveBeenCalled()
  })
})

const toolsUi = (intent: Record<string, unknown>) =>
  ({ resourceUri: AGENT_TOOLS_URI, resourceVersion: 1, orgId: mocks.orgId, intent }) as NativeMcpUi & {
    resourceUri: typeof AGENT_TOOLS_URI
  }

describe('native agent tools and skills roster', () => {
  it('mounts both of the agent’s rosters, so a row can be removed as well as added', async () => {
    await act(async () => {
      root.render(<AgentToolsDialog ui={toolsUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(element.textContent).toContain('MCP roster')
    expect(element.textContent).toContain('Skills roster')
    expect(mocks.toolsCardProps).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: mocks.agentId, runtime: 'claude', canEdit: true })
    )
  })

  it('narrows to the named roster', async () => {
    await act(async () => {
      root.render(
        <AgentToolsDialog
          ui={toolsUi({ agentId: mocks.agentId, focus: 'skills' })}
          onClose={vi.fn()}
          onCompleted={vi.fn()}
        />
      )
    })
    expect(element.textContent).toContain('Skills roster')
    expect(mocks.toolsCardProps).not.toHaveBeenCalled()
  })

  it('reports the resulting roster as counts, and only when the reader says they are done', async () => {
    const completed = vi.fn()
    mocks.fetchAgentDto.mockResolvedValue({ mcpServers: ['docs'], skills: ['a/*', 'b/x'], managedSkills: ['m1'] })
    await act(async () => {
      root.render(
        <AgentToolsDialog ui={toolsUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={completed} />
      )
    })
    expect(completed).not.toHaveBeenCalled()
    await act(async () => click('Done'))
    expect(completed).toHaveBeenCalledWith(
      'Reviewed my-agent’s tools and skills — 1 MCP server(s) attached · 3 skill(s) enabled.'
    )
  })

  it('closes the rows for the duration of that read, so no edit lands outside the reported state', async () => {
    let settle: (dto: unknown) => void = () => {}
    mocks.fetchAgentDto.mockReturnValue(new Promise((resolve) => (settle = resolve)))
    await act(async () => {
      root.render(<AgentToolsDialog ui={toolsUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    await act(async () => click('Done'))
    expect(mocks.skillsCardProps).toHaveBeenLastCalledWith(expect.objectContaining({ canEdit: false }))
    await act(async () => settle({ mcpServers: [], skills: [] }))
    expect(element.textContent).not.toContain('not change them')
  })

  it('holds Done while a row is still saving, so the counts it reports are not stale', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(
        <AgentToolsDialog ui={toolsUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={completed} />
      )
    })
    await act(async () => click('Skills roster saves'))
    expect(element.textContent).toContain('Saving…')
    const done = [...element.querySelectorAll('button')].find((item) => item.textContent === 'Done')!
    expect(done.hasAttribute('disabled')).toBe(true)
    await act(async () => done.click())
    expect(mocks.fetchAgentDto).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
  })

  it('still shows a read-only reader the rosters, and says so', async () => {
    mocks.canEdit = false
    await act(async () => {
      root.render(<AgentToolsDialog ui={toolsUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(mocks.skillsCardProps).toHaveBeenCalledWith(expect.objectContaining({ canEdit: false }))
    expect(element.textContent).toContain('not change them')
  })
})

describe('native skill installer', () => {
  it('opens the registry search preseeded with the requested name and installs nothing on open', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(<SkillSetupDialog ui={skillUi({ query: 'postgres' })} onClose={vi.fn()} onCompleted={completed} />)
    })
    expect(mocks.registryProps).toHaveBeenCalledWith(expect.objectContaining({ initialQuery: 'postgres' }))
    expect(completed).not.toHaveBeenCalled()
    expect(mocks.updateAgent).not.toHaveBeenCalled()
  })

  it('opens the Git import when the intent asks for it', async () => {
    await act(async () => {
      root.render(<SkillSetupDialog ui={skillUi({ source: 'git' })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(element.textContent).toContain('Git import')
  })

  it('enables an installed source on the requested agent without dropping its other sources', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(
        <SkillSetupDialog ui={skillUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={completed} />
      )
    })
    await act(async () => click('Registry install'))
    expect(mocks.updateAgent).toHaveBeenCalledWith(mocks.agentId, { skills: ['other/*', 'runbooks/*'] })
    expect(completed).toHaveBeenCalledWith(expect.stringContaining('enabled it on my-agent'))
  })

  it('reports a failed enable as a failed enable, not as a failed install', async () => {
    const completed = vi.fn()
    mocks.updateAgent.mockRejectedValue(new Error('agent is paused'))
    await act(async () => {
      root.render(
        <SkillSetupDialog ui={skillUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={completed} />
      )
    })
    await act(async () => click('Registry install'))
    const summary = completed.mock.calls[0]![0] as string
    expect(summary).toContain('Installed the skill library runbooks')
    expect(summary).toContain('agent is paused')
  })

  it('offers no form to a viewer or for an agent the reader cannot edit', async () => {
    mocks.role = 'viewer'
    await act(async () => {
      root.render(<SkillSetupDialog ui={skillUi({})} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(element.textContent).toContain('cannot install skills')
    mocks.role = 'admin'
    mocks.canEdit = false
    await act(async () => {
      root.render(<SkillSetupDialog ui={skillUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={vi.fn()} />)
    })
    expect(mocks.registryProps).not.toHaveBeenCalled()
  })
})

describe('native MCP installer', () => {
  it('attaches the new server to the requested agent and reports both writes', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(<McpSetupDialog ui={mcpUi({ agentId: mocks.agentId })} onClose={vi.fn()} onCompleted={completed} />)
    })
    await act(async () => click('Add server'))
    expect(mocks.updateAgent).toHaveBeenCalledWith(mocks.agentId, { mcpServers: ['docs', 'linear'] })
    expect(completed).toHaveBeenCalledWith(expect.stringContaining('attached it to my-agent'))
  })

  it('adds the server alone when no agent was named, and touches no agent', async () => {
    const completed = vi.fn()
    await act(async () => {
      root.render(<McpSetupDialog ui={mcpUi({})} onClose={vi.fn()} onCompleted={completed} />)
    })
    await act(async () => click('Add server'))
    expect(mocks.updateAgent).not.toHaveBeenCalled()
    expect(completed).toHaveBeenCalledWith('Added the MCP server linear.')
  })

  it('refuses another organization’s intent before mounting the form', async () => {
    await act(async () => {
      root.render(
        <McpSetupDialog ui={{ ...mcpUi({}), orgId: mocks.agentId }} onClose={vi.fn()} onCompleted={vi.fn()} />
      )
    })
    expect(element.textContent).toContain('another organization')
    expect(mocks.mcpProps).not.toHaveBeenCalled()
  })
})

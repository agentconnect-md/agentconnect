// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODE_HOST_SETUP_URI, type NativeMcpUi } from '@agentconnect.md/protocol/mcp-app'
import CodeHostSetupDialog from './CodeHostSetupDialog'

const mocks = vi.hoisted(() => ({
  orgId: '11111111-1111-4111-8111-111111111111',
  role: 'owner' as string,
  cardProps: vi.fn(),
  card:
    (name: string) =>
    (props: unknown): unknown => {
      mocks.cardProps({ name, props })
      return <div>{name} card</div>
    }
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: mocks.orgId }, myRole: mocks.role }) }))
vi.mock('@/lib/api', () => ({
  fetchGithubInstallations: async () => ({ enabled: true, installations: [{ id: 'i1' }, { id: 'i2' }] }),
  fetchGitlabConnections: async () => ({ enabled: true, connections: [{ id: 'c1' }] }),
  fetchGiteaConnections: async () => ({ enabled: false, connections: [] })
}))
vi.mock('@/components/console/GithubCard', () => ({ default: mocks.card('GitHub') }))
vi.mock('@/components/console/GitlabCard', () => ({ default: mocks.card('GitLab') }))
vi.mock('@/components/console/GiteaCard', () => ({ default: mocks.card('Gitea') }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let element: HTMLDivElement
let root: ReturnType<typeof createRoot>
type CodeHostUi = Extract<NativeMcpUi, { resourceUri: typeof CODE_HOST_SETUP_URI }>
const ui = (provider?: 'github' | 'gitlab' | 'gitea'): CodeHostUi => ({
  resourceUri: CODE_HOST_SETUP_URI,
  resourceVersion: 1,
  orgId: mocks.orgId,
  intent: provider ? { provider } : {}
})
const button = (label: string) => [...element.querySelectorAll('button')].find((item) => item.textContent === label)!
const render = (node: React.ReactNode) => act(() => root.render(node))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.role = 'owner'
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(() => {
  act(() => root.unmount())
  element.remove()
})

describe('CodeHostSetupDialog', () => {
  it('shows the whole surface, or the one card the intent named', () => {
    render(<CodeHostSetupDialog ui={ui()} onClose={vi.fn()} onCompleted={vi.fn()} />)
    expect(element.textContent).toContain('GitHub card')
    expect(element.textContent).toContain('GitLab card')
    expect(element.textContent).toContain('Gitea card')

    render(<CodeHostSetupDialog ui={ui('gitlab')} onClose={vi.fn()} onCompleted={vi.fn()} />)
    expect(element.textContent).toContain('GitLab card')
    expect(element.textContent).not.toContain('GitHub card')
    expect(element.textContent).not.toContain('Gitea card')
  })

  it('passes the page’s own role gating to the cards', () => {
    mocks.role = 'viewer'
    render(<CodeHostSetupDialog ui={ui('github')} onClose={vi.fn()} onCompleted={vi.fn()} />)
    expect(mocks.cardProps).toHaveBeenCalledWith({ name: 'GitHub', props: { canWrite: false, isOwner: false } })
  })

  it('refuses a surface that belongs to another organization', () => {
    render(<CodeHostSetupDialog ui={{ ...ui(), orgId: 'other' }} onClose={vi.fn()} onCompleted={vi.fn()} />)
    expect(element.textContent).toContain('another organization')
    expect(mocks.cardProps).not.toHaveBeenCalled()
  })

  it('closing reports nothing; Done reports counts and no identities', async () => {
    const onClose = vi.fn()
    const onCompleted = vi.fn()
    render(<CodeHostSetupDialog ui={ui()} onClose={onClose} onCompleted={onCompleted} />)
    await act(async () => button('Close').click())
    expect(onCompleted).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()

    await act(async () => button('Done').click())
    const summary = onCompleted.mock.calls[0]![0] as string
    expect(summary).toContain('GitHub: 2 installation(s)')
    expect(summary).toContain('GitLab: 1 connection(s)')
    expect(summary).toContain('Gitea: not configured')
  })
})

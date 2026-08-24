// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agents: [] as Array<Record<string, unknown>>,
  daemons: [] as Array<Record<string, unknown>>,
  openModal: vi.fn(),
  push: vi.fn()
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/lib/data-context', () => ({
  useConsoleData: () => ({ agents: mocks.agents, daemons: mocks.daemons })
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ orgPath: (path: string) => `/acme${path}` }) }))
vi.mock('./ModalProvider', () => ({ useModal: () => ({ openModal: mocks.openModal }) }))

import { useGsActions } from './GettingStartedChecklist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let run: (action: Parameters<ReturnType<typeof useGsActions>['runAction']>[0]) => void

function Probe() {
  const { runAction } = useGsActions()
  run = runAction
  return null
}

const render = async () => {
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
}

beforeEach(() => {
  mocks.agents = [{ id: 'ag_ac', builtin: true, name: 'agentconnect', daemon: '—', runtime: '' }]
  mocks.daemons = []
  mocks.openModal.mockReset()
  mocks.push.mockReset()
})

afterEach(() => act(() => root.unmount()))

// The checklist no longer carries a "Connect a daemon" step, so the agent step must
// supply the missing route itself — same chain as the Agents / Agent detail "Add
// daemon" chips (AddDaemonModal chains back into the edit dialog on Continue).
describe('useGsActions — the agent step', () => {
  it('mints a daemon first when the org has none, chaining into the agent editor', async () => {
    await render()
    act(() => run({ kind: 'agent' }))
    expect(mocks.openModal).toHaveBeenCalledWith('daemon', mocks.agents[0], { focusSection: 'basics' })
  })

  it('edits the built-in agent directly once a daemon exists', async () => {
    mocks.daemons = [{ daemonId: 'dmn_1', status: 'online' }]
    await render()
    act(() => run({ kind: 'agent' }))
    expect(mocks.openModal).toHaveBeenCalledWith('editAgent', mocks.agents[0], { focusSection: 'basics' })
  })

  it('falls back to the create dialog for an org with no agent row at all', async () => {
    mocks.agents = []
    await render()
    act(() => run({ kind: 'agent' }))
    expect(mocks.openModal).toHaveBeenCalledWith('agent')
  })
})

// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, setApiOrgId, type ClusterEnvelopeStatusDto, type ClusterExecutionSettingsDto } from '@/lib/api'

let settingsAnswer: ClusterExecutionSettingsDto | Error
let statusAnswer: ClusterEnvelopeStatusDto | Error
const issued = vi.fn()

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    fetchClusterExecution: async () => {
      if (settingsAnswer instanceof Error) throw settingsAnswer
      return settingsAnswer
    },
    fetchClusterExecutionStatus: async () => {
      if (statusAnswer instanceof Error) throw statusAnswer
      return statusAnswer
    },
    issueClusterExecutionCredential: (...args: unknown[]) => issued(...args)
  }
})

import { ClusterExecutionCard } from './ClusterExecutionCard'

const SETTINGS: ClusterExecutionSettingsDto = {
  enabled: true,
  targetNamespace: 'ac-org-acme',
  controlNamespace: 'agentconnect-control',
  suspend: false,
  daemonImage: 'registry.example.test/daemon:1',
  daemonTier: 'small',
  credentialSecretName: 'ac-daemon-token',
  runtimeImage: 'registry.example.test/runtime:1',
  runtimeTiers: [{ name: 'small', warmReplicas: 1 }],
  quota: { maxAgents: 0, cpu: '0', memory: '0', storage: '0' },
  egressPolicy: 'curated',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const STATUS: ClusterEnvelopeStatusDto = {
  present: true,
  conditions: [
    { type: 'Ready', status: 'True' },
    { type: 'CredentialReady', status: 'False', reason: 'Pending' },
    { type: 'Degraded', status: 'False' }
  ],
  daemon: { ready: true },
  sandboxes: { total: 3, running: 2, suspended: 1 },
  pools: [{ name: 'small', warmAvailable: 1, claimed: 2 }]
}

let host: HTMLDivElement
let root: Root

async function render(node: ReactNode) {
  await act(async () => {
    root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>)
  })
  // One more turn for the settings read and the status read behind it to settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((element) => element.textContent === label)
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  setApiOrgId('org-test')
  settingsAnswer = SETTINGS
  statusAnswer = STATUS
  issued.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  setApiOrgId(null)
})

describe('cluster execution card', () => {
  it('renders nothing where the deployment mounts no cluster routes', async () => {
    settingsAnswer = new ApiError('not found', 404)
    await render(<ClusterExecutionCard orgId="org-test" isOwner />)
    expect(host.textContent).toBe('')
  })

  it('renders nothing for a non-owner', async () => {
    await render(<ClusterExecutionCard orgId="org-test" isOwner={false} />)
    expect(host.textContent).toBe('')
  })

  it('shows the operator’s conditions, not the stored row', async () => {
    await render(<ClusterExecutionCard orgId="org-test" isOwner />)

    expect(host.textContent).toContain('Ready')
    expect(host.textContent).toContain('Credential')
    // A fault condition that is False is not news, so it is left out.
    expect(host.textContent).not.toContain('Degraded')
    expect(host.textContent).toContain('ac-org-acme')
  })

  it('offers to issue a first credential, and never shows a key', async () => {
    await render(<ClusterExecutionCard orgId="org-test" isOwner />)

    expect(host.textContent).toContain('Not issued')
    expect(button('Issue')).toBeDefined()
    expect(button('Rotate')).toBeUndefined()
  })

  it('confirms before rotating, because a rotation recreates the daemon pod', async () => {
    settingsAnswer = { ...SETTINGS, credentialRevision: 'rev-1' }
    await render(<ClusterExecutionCard orgId="org-test" isOwner />)
    expect(host.textContent).toContain('rev-1')

    await act(async () => {
      button('Rotate')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.textContent).toContain('Rotate the daemon credential?')
    expect(issued).not.toHaveBeenCalled()
  })

  it('says the envelope is not there yet rather than reporting it as unhealthy', async () => {
    statusAnswer = { present: false, conditions: [] }
    await render(<ClusterExecutionCard orgId="org-test" isOwner />)
    expect(host.textContent).toContain('No envelope in the cluster yet')
  })
})

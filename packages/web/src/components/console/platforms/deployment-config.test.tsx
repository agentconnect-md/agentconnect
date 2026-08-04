// @vitest-environment happy-dom

// `GET /slack/config` is answered per organization AND per caller, and the
// console keeps ONE SWR cache above the `[slug]` segment while an org switch is
// a client-side navigation. So the wizard's shared deployment probe must key
// (and seed) by the ACTIVE organization: a global key would hand organization B
// organization A's funnel/auto/platform-install flags and route the wizard into
// a flow that cannot succeed there.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlackConfigDto } from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'

const mocks = vi.hoisted(() => ({
  activeOrgId: 'org-a' as string | null,
  fetchSlackConfig: vi.fn<() => Promise<SlackConfigDto>>()
}))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  fetchSlackConfig: mocks.fetchSlackConfig
}))
vi.mock('@/lib/org-context', () => ({
  useOrgs: () => ({ activeOrg: mocks.activeOrgId ? { id: mocks.activeOrgId } : null })
}))

import { useDeploymentConfig } from './deployment-config'

function config(over: Partial<SlackConfigDto> = {}): SlackConfigDto {
  return {
    configured: false,
    durable: false,
    funnelEnabled: false,
    autoAvailable: false,
    accessExpiresAt: null,
    relayAvailable: false,
    relayPublicUrl: null,
    platformInstallAvailable: false,
    updatedAt: null,
    ...over
  }
}

let applyLatest: ((next: SlackConfigDto) => void) | null = null

function Probe() {
  const probe = useDeploymentConfig(true)
  applyLatest = probe.apply
  return (
    <output data-probe>
      {probe.config === null ? 'pending' : `funnel=${probe.config.funnelEnabled} relay=${probe.config.relayAvailable}`}
    </output>
  )
}

let host: HTMLDivElement
let root: Root

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

// One cache for the whole case, exactly like ConsoleShell's: it is what survives
// an org switch, and the whole point of the key carrying the org id.
async function renderProbe(): Promise<void> {
  await act(async () => {
    root.render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Probe />
      </SWRConfig>
    )
  })
  await settle()
}

const shown = () => host.querySelector('[data-probe]')?.textContent

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocks.activeOrgId = 'org-a'
  applyLatest = null
  mocks.fetchSlackConfig.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('useDeploymentConfig', () => {
  it('keys the probe by the active organization', () => {
    expect(consoleKeys.deploymentConfig('org-a')).toEqual(['console', 'org-a', 'deployment-config'])
    expect(consoleKeys.deploymentConfig('org-b')).not.toEqual(consoleKeys.deploymentConfig('org-a'))
  })

  it('does not serve the previous organization’s answer after a switch', async () => {
    mocks.fetchSlackConfig.mockImplementation(async () =>
      mocks.activeOrgId === 'org-a'
        ? config({ funnelEnabled: true, relayAvailable: true })
        : config({ funnelEnabled: false, relayAvailable: false })
    )

    await renderProbe()
    expect(shown()).toBe('funnel=true relay=true')
    expect(mocks.fetchSlackConfig).toHaveBeenCalledTimes(1)

    // The org switcher is a client-side navigation: the cache above `[slug]`
    // survives it, so only the key can keep the two answers apart.
    mocks.activeOrgId = 'org-b'
    await renderProbe()
    expect(shown()).toBe('funnel=false relay=false')
    expect(mocks.fetchSlackConfig).toHaveBeenCalledTimes(2)
  })

  it('seeds apply() into the organization the answer came from', async () => {
    mocks.fetchSlackConfig.mockImplementation(async () => config())

    await renderProbe()
    expect(shown()).toBe('funnel=false relay=false')

    // The Slack config-token save answers with a fresh status DTO for THIS org.
    await act(async () => applyLatest?.(config({ funnelEnabled: true, relayAvailable: true })))
    expect(shown()).toBe('funnel=true relay=true')

    // …which must not become the next organization's answer.
    mocks.activeOrgId = 'org-b'
    await renderProbe()
    expect(shown()).toBe('funnel=false relay=false')
  })

  it('stays pending — never guesses — while the organization is unresolved', async () => {
    mocks.activeOrgId = null
    mocks.fetchSlackConfig.mockImplementation(async () => config({ funnelEnabled: true }))

    await renderProbe()
    expect(shown()).toBe('pending')
    expect(mocks.fetchSlackConfig).not.toHaveBeenCalled()
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SWRConfig, type SWRConfiguration } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProviderKeysSection from './ProviderKeysSection'

const mocks = vi.hoisted(() => ({
  orgId: 'example-org',
  role: 'owner',
  fetchProviderKeys: vi.fn(),
  setProviderKey: vi.fn(),
  deleteProviderKey: vi.fn()
}))
vi.mock('@/lib/api', () => ({
  fetchProviderKeys: mocks.fetchProviderKeys,
  setProviderKey: mocks.setProviderKey,
  deleteProviderKey: mocks.deleteProviderKey
}))
vi.mock('@/lib/org-context', () => ({ useOrgs: () => ({ activeOrg: { id: mocks.orgId }, myRole: mocks.role }) }))

const empty = {
  provider: 'typesafe',
  name: 'TypeSafe (Jev)',
  defaultEndpoint: 'https://api.example.test',
  endpointRequired: false,
  endpoint: null,
  headerNames: [],
  configured: false,
  updatedAt: null
}
const configured = { ...empty, configured: true, updatedAt: '2026-01-01T00:00:00.000Z' }
let root: ReturnType<typeof createRoot>
let element: HTMLDivElement
let swrConfig: SWRConfiguration
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const render = () =>
  act(async () => {
    root.render(
      <SWRConfig value={swrConfig}>
        <ProviderKeysSection />
      </SWRConfig>
    )
  })
async function click(label: string) {
  const button = [...element.querySelectorAll('button')].find((button) => button.textContent === label)
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
  })
}
async function enterKey(value: string, input = element.querySelector('input')!) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.orgId = 'example-org'
  mocks.role = 'owner'
  mocks.fetchProviderKeys.mockResolvedValue([empty])
  mocks.setProviderKey.mockResolvedValue(configured)
  mocks.deleteProviderKey.mockResolvedValue(undefined)
  swrConfig = { provider: () => new Map() }
  element = document.createElement('div')
  document.body.append(element)
  root = createRoot(element)
})
afterEach(async () => {
  await act(async () => root.unmount())
  element.remove()
})

describe('Provider keys configuration', () => {
  it('keeps optional connection settings open while editing the endpoint and headers', async () => {
    await render()
    await click('Add key')
    const details = element.querySelector('details')!
    expect(details.open).toBe(false)
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    const endpoint = element.querySelector<HTMLInputElement>('input[type="url"]')!
    await enterKey('h', endpoint)
    expect(details.open).toBe(true)
    await enterKey('https://gateway.example.test/v1', endpoint)
    await click('Add header')
    await act(async () => {
      element.querySelector<HTMLButtonElement>('button[aria-label="Remove header"]')!.click()
    })
    expect(details.open).toBe(true)
    expect(endpoint.value).toBe('https://gateway.example.test/v1')
    await enterKey('example-key')
    await click('Save')
    expect(mocks.setProviderKey).toHaveBeenCalledWith('example-org', 'typesafe', {
      apiKey: 'example-key',
      endpoint: 'https://gateway.example.test/v1',
      headers: {}
    })
  })

  it('edits a gateway and patches headers while preserving omitted credentials', async () => {
    const gateway = {
      ...configured,
      provider: 'cloudflare',
      name: 'Cloudflare AI Gateway',
      endpointRequired: true,
      endpoint: 'https://gateway.example.test/v1',
      defaultEndpoint: null,
      headerNames: ['cf-aig-authorization']
    }
    mocks.fetchProviderKeys.mockResolvedValue([gateway])
    mocks.setProviderKey.mockResolvedValue(gateway)
    await render()
    await click('Edit')
    expect(element.querySelector<HTMLInputElement>('input[type="url"]')!.value).toBe(gateway.endpoint)
    expect(element.querySelector('input')!.value).toBe('')
    await click('Save')
    expect(mocks.setProviderKey).toHaveBeenLastCalledWith('example-org', 'cloudflare', {
      endpoint: gateway.endpoint,
      headers: {}
    })
    await click('Edit')
    expect(element.querySelector<HTMLInputElement>('input[aria-label="Header value"]')!.value).toBe('')
    await click('Add header')
    const names = element.querySelectorAll<HTMLInputElement>('input[aria-label="Header name"]')
    const values = element.querySelectorAll<HTMLInputElement>('input[aria-label="Header value"]')
    await enterKey('CF-AIG-Authorization', names[1]!)
    await enterKey('example-new-value', values[1]!)
    expect(element.textContent).toContain('Header names must be unique')
    await enterKey('X-Extra', names[1]!)
    await act(async () => {
      element.querySelector<HTMLButtonElement>('button[aria-label="Remove header"]')!.click()
    })
    await click('Save')
    expect(mocks.setProviderKey).toHaveBeenLastCalledWith('example-org', 'cloudflare', {
      endpoint: gateway.endpoint,
      headers: { 'cf-aig-authorization': null, 'x-extra': 'example-new-value' }
    })
  })

  it('saves and replaces through a password field and removes only after confirmation', async () => {
    await render()
    await click('Add key')
    expect(element.querySelector('input')!.type).toBe('password')
    await enterKey('example-key')
    await click('Save')
    expect(mocks.setProviderKey).toHaveBeenCalledWith('example-org', 'typesafe', {
      apiKey: 'example-key',
      endpoint: null,
      headers: {}
    })
    expect(element.querySelector('input')).toBeNull()
    expect(element.textContent).toContain('Configured')
    await click('Edit')
    expect(element.querySelector('input')!.value).toBe('')
    await enterKey('example-replacement')
    await click('Save')
    expect(mocks.setProviderKey).toHaveBeenLastCalledWith('example-org', 'typesafe', {
      apiKey: 'example-replacement',
      endpoint: null,
      headers: {}
    })
    await click('Remove key')
    expect(mocks.deleteProviderKey).not.toHaveBeenCalled()
    const dialog = element.querySelector('[role="dialog"]')!
    await act(async () => {
      ;[...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Remove key')!.click()
    })
    expect(mocks.deleteProviderKey).toHaveBeenCalledWith('example-org', 'typesafe')
    expect(element.textContent).toContain('Not configured')
  })

  it('clears unsaved input on organization switches and never offers mutations to non-owners', async () => {
    await render()
    await click('Add key')
    await enterKey('example-unsaved-key')
    mocks.orgId = 'other-org'
    await render()
    expect(element.querySelector('input')).toBeNull()
    expect(mocks.setProviderKey).not.toHaveBeenCalled()
    await click('Add key')
    expect(element.querySelector('input')!.value).toBe('')
    await enterKey('example-other-key')
    await click('Save')
    expect(mocks.setProviderKey).toHaveBeenCalledWith('other-org', 'typesafe', {
      apiKey: 'example-other-key',
      endpoint: null,
      headers: {}
    })
    mocks.role = 'viewer'
    await render()
    expect(element.textContent).toContain('Only organization owners')
    expect(element.querySelector('button')).toBeNull()
  })

  it('does not label a failed write as configured or display raw upstream errors', async () => {
    mocks.setProviderKey.mockRejectedValue(new Error('failed: example-secret'))
    await render()
    await click('Add key')
    await enterKey('example-secret')
    await click('Save')
    expect(element.textContent).toContain('Could not save the key')
    expect(element.textContent).toContain('Not configured')
    expect(element.textContent).not.toContain('example-secret')
    await click('Cancel')
    await click('Add key')
    expect(element.querySelector('input')!.value).toBe('')
  })
})

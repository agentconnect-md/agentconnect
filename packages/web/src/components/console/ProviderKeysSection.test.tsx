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

const empty = { provider: 'typesafe', name: 'TypeSafe (Jev)', configured: false, updatedAt: null }
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
async function enterKey(value: string) {
  const input = element.querySelector('input')!
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
  it('saves and replaces through a password field and removes only after confirmation', async () => {
    await render()
    await click('Add key')
    expect(element.querySelector('input')!.type).toBe('password')
    await enterKey('example-key')
    await click('Save key')
    expect(mocks.setProviderKey).toHaveBeenCalledWith('example-org', 'typesafe', 'example-key')
    expect(element.querySelector('input')).toBeNull()
    expect(element.textContent).toContain('Configured')
    await click('Replace key')
    expect(element.querySelector('input')!.value).toBe('')
    await enterKey('example-replacement')
    await click('Save key')
    expect(mocks.setProviderKey).toHaveBeenLastCalledWith('example-org', 'typesafe', 'example-replacement')
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
    await click('Save key')
    expect(mocks.setProviderKey).toHaveBeenCalledWith('other-org', 'typesafe', 'example-other-key')
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
    await click('Save key')
    expect(element.textContent).toContain('Could not save the key')
    expect(element.textContent).toContain('Not configured')
    expect(element.textContent).not.toContain('example-secret')
    await click('Cancel')
    await click('Add key')
    expect(element.querySelector('input')!.value).toBe('')
  })
})

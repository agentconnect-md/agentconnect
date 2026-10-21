// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerEgressDto, ComputerQuotaStatusDto, ComputerQuotas } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const defaults: ComputerQuotas = {
  runningDesktops: 3,
  desktops: 10,
  storageGib: null,
  monthlyDesktopHours: 300,
  modes: {},
  viewers: 5,
  viewersPerComputer: 3,
  monthlyViewerGib: 100,
  screenshotStorageGib: 10,
  screenshotRetentionDays: null
}

const status = (over: Partial<ComputerQuotaStatusDto> = {}): ComputerQuotaStatusDto => ({
  defaults,
  override: null,
  limits: defaults,
  used: {
    runningDesktops: 3,
    desktops: 4,
    storageGib: 20,
    monthlyDesktopHours: 12.5,
    modes: {
      ephemeral: { runningDesktops: 1, desktops: 1 },
      'per-agent': { runningDesktops: 2, desktops: 3 },
      manual: { runningDesktops: 0, desktops: 0 }
    },
    viewers: 1,
    monthlyViewerGib: 0.5,
    screenshotStorageGib: 0.1
  },
  volumeGib: 5,
  canEdit: false,
  ...over
})

const egress = (over: Partial<ComputerEgressDto> = {}): ComputerEgressDto => ({
  mode: 'deployment',
  url: null,
  username: null,
  passwordSet: false,
  orgProxyAllowed: true,
  description: null,
  canEdit: true,
  ...over
})

const mocks = vi.hoisted(() => ({
  quotas: null as unknown,
  egress: null as unknown,
  mutate: vi.fn(),
  setComputerQuotas: vi.fn(),
  setComputerEgress: vi.fn()
}))

vi.mock('@/lib/computers', () => ({
  useComputerQuotas: () => ({ data: mocks.quotas, mutate: mocks.mutate }),
  useComputerEgress: () => ({ data: mocks.egress, mutate: mocks.mutate })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  setComputerQuotas: mocks.setComputerQuotas,
  setComputerEgress: mocks.setComputerEgress
}))

const { ComputerEgressCard, ComputerQuotasCard } = await import('./ComputerPlanCards')

let root: Root
function render(node: React.ReactNode): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(node))
  return host
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  mocks.mutate.mockClear()
  mocks.setComputerQuotas.mockReset()
  mocks.setComputerEgress.mockReset()
})

describe('ComputerQuotasCard', () => {
  it('shows each limit against what the organization uses, and marks a full one', () => {
    mocks.quotas = status()
    const el = render(<ComputerQuotasCard />)
    expect(el.querySelector('[data-quota-line="Running managed computers"]')?.textContent).toContain('3 of 3')
    expect(el.querySelector('[data-quota-line="Managed computer storage (GiB)"]')?.textContent).toContain(
      '20 · no limit'
    )
    expect(el.querySelector('[data-quota-line="Viewers on one computer"]')?.textContent).toContain('up to 3')
    expect(el.textContent).not.toContain('Edit')
  })

  it('lets a deployment administrator override one limit and lift another', async () => {
    mocks.quotas = status({ canEdit: true })
    mocks.setComputerQuotas.mockResolvedValue(status({ canEdit: true, override: { desktops: 20, viewers: null } }))
    const el = render(<ComputerQuotasCard />)
    act(() => button(el, 'Edit').click())
    type(el.querySelector('input[aria-label="Managed computers held, sleeping ones included"]')!, '20')
    act(() => (el.querySelector('button[aria-label="No limit for Open viewers"]') as HTMLButtonElement).click())
    await act(async () => button(el, 'Save').click())
    expect(mocks.setComputerQuotas).toHaveBeenCalledWith({ desktops: 20, viewers: null })
    expect(mocks.mutate).toHaveBeenCalled()
  })

  it('refuses a limit that is not a whole number', async () => {
    mocks.quotas = status({ canEdit: true })
    const el = render(<ComputerQuotasCard />)
    act(() => button(el, 'Edit').click())
    type(el.querySelector('input[aria-label="Running managed computers"]')!, '1.5')
    await act(async () => button(el, 'Save').click())
    expect(mocks.setComputerQuotas).not.toHaveBeenCalled()
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('must be a whole number')
  })
})

describe('ComputerEgressCard', () => {
  it('states the data-centre limitation, and the deployment’s note', () => {
    mocks.egress = egress({ description: 'Egress from us-west-2', canEdit: false })
    const el = render(<ComputerEgressCard />)
    expect(el.querySelector('[data-egress-limitation]')?.textContent).toContain('data-centre addresses')
    expect(el.textContent).toContain('Egress from us-west-2')
    expect(el.querySelector('[data-egress-mode]')?.getAttribute('data-egress-mode')).toBe('deployment')
    expect(el.textContent).not.toContain('Edit')
  })

  it('sends browser traffic through the organization’s proxy, keeping a stored password unless retyped', async () => {
    mocks.egress = egress({ mode: 'proxy', url: 'http://proxy.example.com:3128', username: 'acme', passwordSet: true })
    mocks.setComputerEgress.mockResolvedValue(egress({ mode: 'proxy', url: 'http://proxy.example.com:8080' }))
    const el = render(<ComputerEgressCard />)
    expect(el.textContent).toContain('Set')
    act(() => button(el, 'Edit').click())
    type(el.querySelector('input[aria-label="Proxy URL"]')!, 'http://proxy.example.com:8080')
    await act(async () => button(el, 'Save').click())
    expect(mocks.setComputerEgress).toHaveBeenCalledWith({
      mode: 'proxy',
      url: 'http://proxy.example.com:8080',
      username: 'acme'
    })
  })

  it('offers no editing where the deployment allows no organization proxy', () => {
    mocks.egress = egress({ orgProxyAllowed: false })
    const el = render(<ComputerEgressCard />)
    expect(el.textContent).toContain('does not let organizations use their own proxy')
    expect(el.textContent).not.toContain('Edit')
  })
})

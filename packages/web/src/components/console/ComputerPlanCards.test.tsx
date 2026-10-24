// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerEgressDto } from '@/lib/api'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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
  egress: null as unknown,
  mutate: vi.fn(),
  setComputerEgress: vi.fn()
}))

vi.mock('@/lib/computers', () => ({
  useComputerEgress: () => ({ data: mocks.egress, mutate: mocks.mutate })
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  setComputerEgress: mocks.setComputerEgress
}))

const { ComputerEgressCard } = await import('./ComputerPlanCards')

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
  mocks.setComputerEgress.mockReset()
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

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { FillCardAnswer, FillCardBody } from '@/lib/data'
import { FillCard } from './FillCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.parse('2026-11-10T10:00:00.000Z')
const card = (overrides: Partial<FillCardBody> = {}): FillCardBody => ({
  requestId: '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
  computerName: 'Desk',
  website: { origin: 'https://login.example.test', title: 'Sign in' },
  kind: 'login',
  fields: [
    { id: 'f1', control: 'email', purpose: 'username', label: 'Email', required: true, secret: false, empty: true },
    {
      id: 'f2',
      control: 'password',
      purpose: 'current-password',
      label: 'Password',
      required: true,
      secret: true,
      empty: true
    },
    {
      id: 'f3',
      control: 'select',
      purpose: 'country',
      label: 'Country',
      required: false,
      secret: false,
      empty: true,
      options: [{ value: 'DE', label: 'Germany' }]
    },
    {
      id: 'f4',
      control: 'checkbox',
      purpose: 'unknown',
      label: 'Remember me',
      required: false,
      secret: false,
      empty: true
    }
  ],
  reason: 'Sign in to open the report',
  expiresAt: new Date(NOW + 600_000).toISOString(),
  ...overrides
})

function render(
  body: FillCardBody,
  onAnswer?: (answer: FillCardAnswer) => Promise<{ accepted: boolean; reason?: string }>
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  act(() => createRoot(host).render(<FillCard body={body} now={() => NOW} {...(onAnswer ? { onAnswer } : {})} />))
  return host
}

const type = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}

describe('FillCard (computer-form-fill-and-vault.md §6)', () => {
  it('shows the website the browser reported, the agent’s reason, and masks every secret', () => {
    const host = render(
      card({ fields: [{ ...card().fields[0]!, id: 'code', control: 'text', purpose: 'one-time-code', secret: true }] }),
      async () => ({ accepted: true })
    )
    expect(host.textContent).toContain('https://login.example.test')
    expect(host.textContent).toContain('Sign in to open the report')
    expect(host.textContent).toContain('stays signed in')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!.type).toBe('password')
    expect(host.textContent).toContain('later screenshots')
    const textarea = render(
      card({
        fields: [
          {
            ...card().fields[0]!,
            id: 'key',
            control: 'textarea',
            purpose: 'unknown',
            label: 'Recovery key',
            secret: true
          }
        ]
      }),
      async () => ({ accepted: true })
    )
    expect(textarea.querySelector('textarea')).toBeNull()
    expect(textarea.querySelector<HTMLInputElement>('input[aria-label="Recovery key"]')!.type).toBe('password')
  })

  it('sends only what the person entered, then drops it from the page', async () => {
    const onAnswer = vi.fn(async () => ({ accepted: true }))
    const host = render(card(), onAnswer)
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!.type).toBe('password')
    type(host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!, 'ada@example.test')
    type(host.querySelector<HTMLInputElement>('input[aria-label="Password"]')!, 'canary-web-pass')
    type(host.querySelector<HTMLSelectElement>('select[aria-label="Country"]')!, 'DE')
    act(() => host.querySelector<HTMLInputElement>('input[aria-label="Remember me"]')!.click())
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(onAnswer).toHaveBeenCalledWith({
      values: [
        { field: 'f1', value: 'ada@example.test' },
        { field: 'f2', value: 'canary-web-pass' },
        { field: 'f3', value: 'DE' },
        { field: 'f4', checked: true }
      ]
    })
    expect(host.querySelector('input')).toBeNull()
    expect(host.innerHTML).not.toContain('canary-web-pass')
    expect(host.textContent).toContain('Sent to the website')
  })

  it('declines with Cancel, and keeps the values when the daemon refuses the answer', async () => {
    const onAnswer = vi.fn(async (answer: FillCardAnswer) =>
      'cancel' in answer
        ? { accepted: true }
        : { accepted: false, reason: 'only the person who asked can answer this Fill card' }
    )
    const host = render(card(), onAnswer)
    type(host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!, 'x@example.test')
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
    expect(host.textContent).toContain('only the person who asked')
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Email"]')!.value).toBe('x@example.test')
    const cancel = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!
    await act(async () => cancel.click())
    expect(onAnswer).toHaveBeenLastCalledWith({ cancel: true })
    expect(host.textContent).toContain('Cancelled')
  })

  it('renders a settled or expired card, or one this reader cannot answer, without controls', () => {
    expect(render(card({ resolved: 'partial' }), async () => ({ accepted: true })).textContent).toContain(
      'Partly filled'
    )
    const expired = render(card({ expiresAt: new Date(NOW - 1).toISOString() }), async () => ({ accepted: true }))
    expect(expired.textContent).toContain('Expired')
    expect(expired.querySelector('input')).toBeNull()
    const record = render(card())
    expect(record.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  })
})

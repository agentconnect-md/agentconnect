// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, expect, it, vi } from 'vitest'
import en from '../../../messages/en.json'
import type { NewConversationMode } from '@/lib/api'
import { NewChannelsDefault } from './NewChannelsDefault'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  host?.remove()
  root = undefined
})

async function render(
  value: NewConversationMode | null,
  onChange: (mode: NewConversationMode) => Promise<void>,
  disabled = false
) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <NextIntlClientProvider locale="en" messages={en}>
        <NewChannelsDefault value={value} disabled={disabled} onChange={onChange} />
      </NextIntlClientProvider>
    )
  )
  return host.querySelector<HTMLButtonElement>('button[aria-label="New channels start on"]')!
}

const pick = async (trigger: HTMLButtonElement, label: string) => {
  await act(async () => trigger.click())
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
    (row) => row.textContent === label
  )!
  await act(async () => option.click())
}

it('reads an unset mode as Auto and offers the three starts', async () => {
  const trigger = await render(null, vi.fn())
  expect(host!.textContent).toContain('New channels start on')
  expect(trigger.textContent).toBe('Auto')
  await act(async () => trigger.click())
  expect([...document.querySelectorAll('[role="menuitemradio"]')].map((row) => row.textContent)).toEqual([
    'Auto',
    '@-mentions · Per thread',
    'Off'
  ])
})

it('saves the pick and shows it at once', async () => {
  const onChange = vi.fn(() => Promise.resolve())
  const trigger = await render('auto', onChange)
  await pick(trigger, 'Off')
  expect(onChange).toHaveBeenCalledWith('off')
  expect(trigger.textContent).toBe('Off')
})

it('falls back to the stored mode when the save fails', async () => {
  const trigger = await render('mention', () => Promise.reject(new Error('denied')))
  await pick(trigger, 'Off')
  expect(trigger.textContent).toBe('@-mentions · Per thread')
})

it('is read-only for a viewer who cannot edit the agent', async () => {
  const trigger = await render('off', vi.fn(), true)
  expect(trigger.disabled).toBe(true)
})

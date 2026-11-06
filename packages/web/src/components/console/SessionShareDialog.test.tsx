// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NextIntlClientProvider } from 'next-intl'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import messages from '../../../messages/en.json'
import { SessionShareDialog, type ShareVisibility } from './SessionShareDialog'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wire = vi.hoisted(() => ({ puts: [] as string[] }))

vi.mock(import('@/lib/api'), async (importOriginal) => ({
  ...(await importOriginal()),
  putSessionVisibility: vi.fn((_id: string, next: string) => {
    wire.puts.push(next)
    return Promise.resolve({ visibility: next, state: 'applied' } as never)
  })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  wire.puts = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const draw = (visibility: ShareVisibility | null, onCopyLink = vi.fn()) =>
  act(() =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SessionShareDialog
          title="Get api 1.5 ready to ship"
          place="#deploys"
          platform="slack"
          copied={false}
          onCopyLink={onCopyLink}
          visibility={visibility}
          onClose={() => {}}
        />
      </NextIntlClientProvider>
    )
  )

const base = { sessionId: 's1', canChange: false, onChanged: () => {} }
const dialog = () => document.querySelector('[data-share-dialog]')!

it('names a Slack-managed audience by its channel and says it follows the channel', () => {
  draw({ ...base, visibility: 'external', externalProvider: 'slack', externalResolution: 'settled' })
  expect(dialog().textContent).toContain('#deploys members in Slack')
  expect(dialog().textContent).toContain('Anyone who can access the channel can see this session.')
  expect(dialog().querySelectorAll('[role="radio"]')).toHaveLength(0)
})

it('shows a reader who cannot change it only the audience that holds, and copies the link', () => {
  const copy = vi.fn()
  draw({ ...base, visibility: 'private' }, copy)
  expect(dialog().querySelectorAll('[data-share-audience]')).toHaveLength(1)
  expect(dialog().textContent).toContain('Only you can see this session.')
  act(() => [...dialog().querySelectorAll('button')].find((b) => b.textContent?.includes('Copy link'))!.click())
  expect(copy).toHaveBeenCalledOnce()
})

it('asks before making a session private, then applies it', async () => {
  draw({ ...base, visibility: 'org', canChange: true })
  const privateChoice = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')][1]!
  act(() => privateChoice.click())
  expect(wire.puts).toEqual([])
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Make private'
  )!
  await act(async () => confirm.click())
  expect(wire.puts).toEqual(['private'])
})

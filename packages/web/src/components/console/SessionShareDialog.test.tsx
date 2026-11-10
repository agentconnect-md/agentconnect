// @vitest-environment happy-dom

import { act, useState } from 'react'
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
const link = 'https://console.example.test/example-org/sessions/session-1?view=flat'

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  wire.puts = []
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function Share({ visibility }: { visibility: ShareVisibility | null }) {
  const [open, setOpen] = useState(true)
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <SessionShareDialog
        open={open}
        title="Get api 1.5 ready to ship"
        place="#deploys"
        platform="slack"
        link={link}
        visibility={visibility}
        onClose={() => setOpen(false)}
      />
    </NextIntlClientProvider>
  )
}

const draw = (visibility: ShareVisibility | null) => act(() => root.render(<Share visibility={visibility} />))
const base = { sessionId: 's1', canChange: false, onChanged: () => {} }
const dialog = () => document.querySelector('[data-share-dialog]')!
const copy = () =>
  [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Copy link')!

it('names a Slack-managed audience by its channel without offering a visibility change', () => {
  draw({ ...base, visibility: 'external', externalProvider: 'slack', externalResolution: 'settled' })
  expect(dialog().textContent).toContain('#deploys members in Slack')
  expect(dialog().textContent).toContain('Anyone who can access the channel can see this session.')
  expect(dialog().querySelector('[aria-haspopup="menu"]')).toBeNull()
})

it('closes only after copying succeeds, then shows a transient confirmation outside the dialog', async () => {
  vi.useFakeTimers()
  let complete!: () => void
  vi.mocked(navigator.clipboard.writeText).mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve
    })
  )
  draw({ ...base, visibility: 'private' })
  expect(dialog().textContent).toContain('Only you can see this session.')
  expect(dialog().textContent).not.toContain('Done')
  expect(dialog().querySelector('textarea')).toBeNull()
  expect(copy().classList.contains('dsbtn-primary')).toBe(true)
  await act(async () => copy().click())
  expect(dialog()).not.toBeNull()
  expect(copy().disabled).toBe(true)
  expect(document.querySelector('[role="status"]')).toBeNull()
  await act(async () => complete())
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link)
  expect(dialog()).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Link copied')
  act(() => vi.advanceTimersByTime(3000))
  expect(document.querySelector('[role="status"]')).toBeNull()
  expect(wire.puts).toEqual([])
})

it.each(['denied', 'unavailable'])(
  'keeps the dialog open with a selected manual link when clipboard access is %s',
  async (reason) => {
    if (reason === 'denied')
      vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
    else vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard)
    draw({ ...base, visibility: 'private' })
    await act(async () => copy().click())
    const field = dialog().querySelector('textarea')!
    expect(field.value).toBe(link)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(link.length)
    expect(document.activeElement).toBe(field)
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Couldn't copy")
    expect(document.querySelector('[role="status"]')).toBeNull()
    expect(copy().disabled).toBe(false)
  }
)

it('ignores a clipboard result after the user dismisses the dialog', async () => {
  let complete!: () => void
  vi.mocked(navigator.clipboard.writeText).mockReturnValue(
    new Promise<void>((resolve) => {
      complete = resolve
    })
  )
  draw(null)
  await act(async () => copy().click())
  act(() => dialog().querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
  await act(async () => complete())
  expect(dialog()).toBeNull()
  expect(document.querySelector('[role="status"]')).toBeNull()
})

it('asks before making a session private, then applies it without closing the share dialog', async () => {
  draw({ ...base, visibility: 'org', canChange: true })
  const privateChoice = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) =>
    b.textContent?.startsWith('Private')
  )!
  act(() => privateChoice.click())
  expect(wire.puts).toEqual([])
  expect(copy().disabled).toBe(true)
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === 'Make private'
  )!
  await act(async () => confirm.click())
  expect(wire.puts).toEqual(['private'])
  expect(dialog()).not.toBeNull()
})

it('keeps copying available while a visibility update is pending', async () => {
  draw({ ...base, visibility: 'private', canChange: true, state: 'pending' })
  expect(copy().disabled).toBe(false)
  expect(dialog().querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Private')
  await act(async () => copy().click())
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link)
  expect(dialog()).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Link copied')
})

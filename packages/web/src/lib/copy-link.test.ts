// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { copyLink } from './copy-link'

const link = 'https://console.example.test/example-org/sessions/session-1'

beforeEach(() =>
  vi.stubGlobal(
    'prompt',
    vi.fn(() => null)
  )
)

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reports success only after the clipboard write completes', async () => {
  let complete!: () => void
  const write = new Promise<void>((resolve) => {
    complete = resolve
  })
  vi.spyOn(navigator.clipboard, 'writeText').mockReturnValue(write)
  const prompt = vi.spyOn(window, 'prompt')
  const settled = vi.fn()
  const result = copyLink(link, 'Copy link').then(settled)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  complete()
  await result
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith(link)
  expect(settled).toHaveBeenCalledWith(true)
  expect(prompt).not.toHaveBeenCalled()
})

it('offers the link for manual copying when clipboard access is denied', async () => {
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Denied', 'NotAllowedError'))
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
  expect(await copyLink(link, 'Copy link')).toBe(false)
  expect(prompt).toHaveBeenCalledWith('Copy link', link)
})

it('offers the link for manual copying when the Clipboard API is unavailable', async () => {
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard)
  const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
  expect(await copyLink(link, '复制链接')).toBe(false)
  expect(prompt).toHaveBeenCalledWith('复制链接', link)
})

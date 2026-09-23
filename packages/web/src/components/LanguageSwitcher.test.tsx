// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const refresh = vi.fn()
const setLocale = vi.fn(async (_locale: string) => {})
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/i18n/actions', () => ({ setLocale: (locale: string) => setLocale(locale) }))
vi.mock('@/components/ui', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }))

import { LanguageSubmenu } from './LanguageSwitcher'

let root: Root | undefined
let container: HTMLDivElement | undefined

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.clearAllMocks()
})

async function render(onPicked = vi.fn()) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<LanguageSubmenu onPicked={onPicked} />))
  return container.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
}

describe('LanguageSubmenu', () => {
  it('opens the locale list as a submenu with the current locale checked', async () => {
    const trigger = await render()
    expect(trigger.textContent).toBe('Language')
    expect(container!.querySelector('[role="menu"]')).toBeNull()

    await act(async () => trigger.click())

    const items = [...container!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(items.map((item) => [item.textContent, item.getAttribute('aria-checked')])).toEqual([
      ['English', 'true'],
      ['简体中文 (Beta)', 'false']
    ])
  })

  it('switches locale and closes the parent menu when another locale is picked', async () => {
    const onPicked = vi.fn()
    const trigger = await render(onPicked)
    await act(async () => trigger.click())

    const zh = container!.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="false"]')!
    await act(async () => zh.click())

    expect(setLocale).toHaveBeenCalledWith('zh-CN')
    expect(refresh).toHaveBeenCalled()
    expect(onPicked).toHaveBeenCalled()
    expect(container!.querySelector('[role="menu"]')).toBeNull()
  })

  it('does not reload for the locale already in use', async () => {
    const trigger = await render()
    await act(async () => trigger.click())

    const en = container!.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')!
    await act(async () => en.click())

    expect(setLocale).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })
})

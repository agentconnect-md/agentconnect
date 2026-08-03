// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SocialLoginButtons from './SocialLoginButtons'
import { selectEnabledProviders } from '@/lib/social-login-providers'

let container: HTMLDivElement
let root: Root

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('SocialLoginButtons regional preference', () => {
  it.each([
    ['lark,feishu', 'lark', 'Lark'],
    ['feishu,lark', 'feishu', 'Feishu']
  ] as const)('defaults %s to %s', async (configured, target, label) => {
    const onContinue = vi.fn()
    await act(async () => {
      root.render(<SocialLoginButtons providers={selectEnabledProviders(configured)} onContinue={onContinue} />)
    })

    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="Continue with ${label}"]`)
    expect(button).not.toBeNull()

    await act(async () => button?.click())
    expect(onContinue).toHaveBeenCalledWith(target)
  })
})

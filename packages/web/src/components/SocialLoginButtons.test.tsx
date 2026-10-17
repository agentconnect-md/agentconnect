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

describe('SocialLoginButtons more options', () => {
  const labels = () =>
    [...container.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? b.textContent)

  it('shows the first four buttons and the rest behind More sign-in options', async () => {
    await act(async () => {
      root.render(<SocialLoginButtons providers={selectEnabledProviders('*')} onContinue={vi.fn()} />)
    })

    expect(labels()).toEqual([
      'Continue with Google',
      'Continue with Slack',
      'Continue with GitHub',
      'Continue with GitLab',
      'More sign-in options'
    ])

    const more = [...container.querySelectorAll('button')].find((b) => b.textContent === 'More sign-in options')
    await act(async () => more?.click())
    expect(labels().slice(5)).toEqual([
      'Continue with Lark',
      'Switch to Feishu',
      'Continue with Discord',
      'Continue with Telegram'
    ])
    expect(labels()).toContain('Fewer options')

    await act(async () => more?.click())
    expect(labels()).not.toContain('Continue with Telegram')
  })

  it('moves the next provider up when one of the first four is not enabled', async () => {
    await act(async () => {
      root.render(
        <SocialLoginButtons providers={selectEnabledProviders('telegram,discord,slack,google')} onContinue={vi.fn()} />
      )
    })
    expect(labels()).toEqual([
      'Continue with Google',
      'Continue with Slack',
      'Continue with Discord',
      'Continue with Telegram'
    ])
  })
})

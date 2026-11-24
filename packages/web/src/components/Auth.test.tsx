// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ login: vi.fn(), loginWithSso: vi.fn() }))
const authState = vi.hoisted(() => ({ on: true }))

vi.mock('@/lib/auth', () => ({
  isAuthConfigured: () => authState.on,
  login: mocks.login,
  loginWithSso: mocks.loginWithSso
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/i18n/actions', () => ({ setLocale: vi.fn() }))

import Auth from './Auth'
import { commitPendingSignIn, readLastSignIn } from '@/lib/organization-sso'
import { selectEnabledProviders } from '@/lib/social-login-providers'

let host: HTMLDivElement
let root: Root

async function render(configured: string, organizationSso = true, sso?: { connectorId: string; name: string }) {
  await act(async () =>
    root.render(
      <Auth
        providers={selectEnabledProviders(configured)}
        organizationSso={organizationSso}
        {...(sso ? { sso } : {})}
      />
    )
  )
}

const bars = () =>
  [...host.querySelectorAll('button.sso, a.sso, div.sso')]
    .filter((node) => !node.hasAttribute('title'))
    .map((node) => node.textContent)
const icons = () => [...host.querySelectorAll('button[title]')].map((node) => node.getAttribute('title'))
const hasDivider = () => [...host.querySelectorAll('div')].some((node) => node.textContent === 'or')
const tagged = () =>
  [...host.querySelectorAll('.sso')]
    .filter((node) => node.textContent?.includes('Last used'))
    .map((node) => node.getAttribute('aria-label') ?? node.textContent!.replace('Last used', ''))

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  authState.on = true
  localStorage.clear()
  sessionStorage.clear()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('sign-in where organizations own SSO connections', () => {
  it('shows three provider bars, the SSO bar, then the rest as icons', async () => {
    await render('*')
    expect(host.querySelector('input')).toBeNull()
    expect(bars()).toEqual(['Continue with Google', 'Continue with GitHub', 'Continue with Slack', 'Continue with SSO'])
    expect(hasDivider()).toBe(true)
    expect(icons()).toEqual([
      'Continue with Microsoft',
      'Continue with GitLab',
      'Continue with Lark / Feishu',
      'Continue with Discord',
      'Continue with Telegram',
      'Continue with Mattermost'
    ])
    expect(host.querySelector('a.sso')!.getAttribute('href')).toBe('/login/sso')
    expect(host.textContent).toContain('First time here?')
  })

  it('shows three or fewer providers as bars with no icon row', async () => {
    await render('slack,google')
    expect(bars()).toEqual(['Continue with Google', 'Continue with Slack', 'Continue with SSO'])
    expect(icons()).toEqual([])
    expect(hasDivider()).toBe(false)
  })

  it('draws a lone leftover as a bar above the SSO bar', async () => {
    await render('google,github,slack,gitlab')
    expect(bars()).toEqual([
      'Continue with Google',
      'Continue with GitHub',
      'Continue with Slack',
      'Continue with GitLab',
      'Continue with SSO'
    ])
    expect(icons()).toEqual([])
    expect(hasDivider()).toBe(false)
  })

  it('tags the method used last in place: a bar, an icon or the SSO bar', async () => {
    localStorage.setItem('ac.lastSignIn', JSON.stringify({ method: 'social', target: 'github' }))
    await render('*')
    expect(tagged()).toEqual(['Continue with GitHub'])
    expect(bars()[1]).toBe('Last usedContinue with GitHub')
    await act(async () => root.unmount())
    root = createRoot(host)

    localStorage.setItem('ac.lastSignIn', JSON.stringify({ method: 'social', target: 'discord' }))
    await render('*')
    expect(tagged()).toEqual(['Continue with Discord'])
    expect(icons()[3]).toBe('Continue with Discord')
    await act(async () => root.unmount())
    root = createRoot(host)

    localStorage.setItem('ac.lastSignIn', JSON.stringify({ method: 'email', email: 'dana@acme.example' }))
    await render('*')
    expect(tagged()).toEqual(['Continue with SSO'])
  })

  it('notes a social sign-in so it is tagged next time', async () => {
    await render('google,github')
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Continue with Google')!.click()
    )
    expect(mocks.login).toHaveBeenCalledWith('google')
    commitPendingSignIn()
    expect(readLastSignIn()).toEqual({ method: 'social', target: 'google' })
  })
})

describe('sign-in where organizations do not own SSO connections', () => {
  const remember = (value: object) => localStorage.setItem('ac.lastSignIn', JSON.stringify(value))
  const deploymentSso = { connectorId: 'deployment-connector', name: 'Example SSO' }
  const rerender = async () => {
    await act(async () => root.unmount())
    root = createRoot(host)
  }

  it('keeps labeled buttons in the new order, no SSO page link and no tag without a remembered method', async () => {
    await render('slack,github,google', false)
    expect(bars()).toEqual(['Continue with Google', 'Continue with GitHub', 'Continue with Slack'])
    expect(host.querySelector('a')).toBeNull()
    expect(tagged()).toEqual([])
  })

  it('tags the method used last in place: a labeled button, an icon or the Lark/Feishu slot', async () => {
    remember({ method: 'social', target: 'github' })
    await render('*', false)
    expect(tagged()).toEqual(['Continue with GitHub'])
    expect(bars()[1]).toBe('Last usedContinue with GitHub')
    await rerender()

    remember({ method: 'social', target: 'discord' })
    await render('*', false)
    expect(tagged()).toEqual(['Continue with Discord'])
    await rerender()

    remember({ method: 'social', target: 'feishu' })
    await render('google,github,slack,azuread,lark,feishu,discord', false)
    expect(tagged()).toEqual(['Continue with Lark / Feishu'])
  })

  it('remembers a sign-in through the deployment connector and tags its button', async () => {
    remember({ method: 'social', target: 'github' })
    await render('google,github', false, deploymentSso)
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Continue with Example SSO')!.click()
    )
    expect(mocks.loginWithSso).toHaveBeenCalledWith('deployment-connector')
    commitPendingSignIn()
    expect(readLastSignIn()).toEqual({ method: 'sso', connectorId: 'deployment-connector' })
    await rerender()

    await render('google,github', false, deploymentSso)
    expect(tagged()).toEqual(['Continue with Example SSO'])
  })

  it('remembers and tags nothing where sign-in is not configured', async () => {
    authState.on = false
    remember({ method: 'social', target: 'github' })
    await render('google,github', false, deploymentSso)
    expect(tagged()).toEqual([])
    await act(async () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Continue with Example SSO')!.click()
    )
    expect(sessionStorage.getItem('ac.pendingSignIn')).toBeNull()
  })
})

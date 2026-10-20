// @vitest-environment happy-dom

import { act } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import LoginPage from './page'
import * as publicEnv from '@/lib/public-env'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/i18n/actions', () => ({ setLocale: vi.fn() }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
  delete window.__AC_ENV
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('renders the configured sign-in buttons before hydration and keeps the same DOM afterward', async () => {
  vi.stubEnv('CP_INTERNAL_URL', 'https://api.example.test/api/v1')
  vi.stubEnv('SOCIAL_PROVIDERS', undefined)
  vi.stubEnv('NEXT_PUBLIC_SOCIAL_PROVIDERS', undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: '1',
          revision: 1,
          config: {
            auth: {
              endpoint: 'https://auth.example.test',
              appId: 'console',
              apiResource: null,
              socialProviders: ['github', 'google', 'slack', 'gitlab', 'discord']
            }
          }
        })
      )
    )
  )

  const script = await publicEnv.PublicEnvScript()
  window.__AC_ENV = JSON.parse(script.props.dangerouslySetInnerHTML.__html.slice('window.__AC_ENV='.length))
  const page = await LoginPage()
  const browserWindow = window
  vi.stubGlobal('window', undefined)
  let html: string
  try {
    html = renderToString(page)
  } finally {
    vi.stubGlobal('window', browserWindow)
  }

  container = document.createElement('div')
  document.body.append(container)
  container.innerHTML = html
  const buttons = [...container.querySelectorAll('button')]
  expect(buttons.map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
    'Continue with Google',
    'Continue with Slack',
    'Continue with GitHub',
    'Continue with GitLab',
    'Continue with Discord'
  ])

  const onRecoverableError = vi.fn()
  await act(async () => {
    root = hydrateRoot(container!, page, { onRecoverableError })
  })
  expect(onRecoverableError).not.toHaveBeenCalled()
  expect(container.querySelector('button')).toBe(buttons[0])
})

it('retains the build-time provider fallback when the runtime snapshot has no provider setting', async () => {
  // Next.js inlines direct NEXT_PUBLIC_* reads; the resolver's dynamic env lookup cannot see build-only values.
  vi.spyOn(publicEnv, 'resolvePublicEnv').mockResolvedValueOnce({})
  vi.stubEnv('NEXT_PUBLIC_SOCIAL_PROVIDERS', 'gitlab')
  const html = renderToString(await LoginPage())
  expect(html).toContain('Continue with GitLab')
  expect(html).not.toContain('Continue with Google')
})

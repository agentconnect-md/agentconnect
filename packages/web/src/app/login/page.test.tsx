// @vitest-environment happy-dom

import { act } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import LoginPage from './page'
import { PublicEnvScript } from '@/lib/public-env'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/i18n/actions', () => ({ setLocale: vi.fn() }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  delete window.__AC_ENV
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

  const script = await PublicEnvScript()
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
  expect(buttons.map((button) => button.textContent)).toEqual([
    'Continue with Google',
    'Continue with Slack',
    'Continue with GitHub',
    'Continue with GitLab',
    'More sign-in options'
  ])

  const onRecoverableError = vi.fn()
  await act(async () => {
    root = hydrateRoot(container!, page, { onRecoverableError })
  })
  expect(onRecoverableError).not.toHaveBeenCalled()
  expect(container.querySelector('button')).toBe(buttons[0])

  await act(async () => buttons[4]!.click())
  expect(container.querySelector('button[aria-label="Continue with Discord"]')).not.toBeNull()
})

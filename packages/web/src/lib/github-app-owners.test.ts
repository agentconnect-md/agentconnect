// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { authorizeGithubAppOwners, fetchGithubAppOwners } from './api'
import { selectGithubAppOwners } from './github-app-owners'

vi.mock('./api', () => ({
  authorizeGithubAppOwners: vi.fn(async () => ({ authorizationUri: 'https://github.com/login/oauth/authorize' })),
  fetchGithubAppOwners: vi.fn(async () => ({ personal: 'example-user', organizations: ['example-org'] }))
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('accepts only the matching popup, origin, and state and exchanges with the original PKCE verifier', async () => {
  const popup = { closed: false, location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const result = selectGithubAppOwners('agent-a', 'org-a', new AbortController().signal)
  await vi.waitFor(() => expect(popup.location.href).toContain('github.com'))
  const [, state, challenge] = vi.mocked(authorizeGithubAppOwners).mock.calls[0]!
  const message = { type: 'github-app-owners:', state, code: 'example-code' }
  const send = (origin: string, source: unknown, data = message) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source: source as Window,
        data
      })
    )
  send('https://other.example.test', popup)
  send(window.location.origin, window)
  send(window.location.origin, popup, { ...message, state: 'wrong-state' })
  await Promise.resolve()
  expect(fetchGithubAppOwners).not.toHaveBeenCalled()
  send(window.location.origin, popup)
  await expect(result).resolves.toEqual({ personal: 'example-user', organizations: ['example-org'] })
  const [agentId, code, verifier, orgId] = vi.mocked(fetchGithubAppOwners).mock.calls[0]!
  expect([agentId, code, orgId]).toEqual(['agent-a', 'example-code', 'org-a'])
  expect(
    Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url')
  ).toBe(challenge)
  expect(popup.close).toHaveBeenCalledOnce()
})

it('closes the popup on cancellation without exchanging a code', async () => {
  const popup = { closed: false, location: { href: '' }, close: vi.fn() }
  vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
  const controller = new AbortController()
  const result = selectGithubAppOwners('agent-a', 'org-a', controller.signal)
  const rejected = expect(result).rejects.toThrow('authorization-cancelled')
  await vi.waitFor(() => expect(popup.location.href).toContain('github.com'))
  controller.abort()
  await rejected
  expect(popup.close).toHaveBeenCalledOnce()
  expect(fetchGithubAppOwners).not.toHaveBeenCalled()
})

import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { LogtoApiError } from '../../github/logto-identity.js'
import type { HttpDeps } from '../deps.js'
import { installZod } from '../plugins/zod.js'
import { meSocialIdentityRoutes } from './me-social-identities.js'

describe('my social identities routes', () => {
  it('uses the OIDC subject and server-owned callback for link and unlink', async () => {
    const identity = {
      createSocialAuthorization: vi.fn(async () => ({
        connectorId: 'google-connector',
        redirectTo: 'https://accounts.example.test/authorize'
      })),
      linkSocialIdentity: vi.fn(async () => undefined),
      unlinkSocialIdentity: vi.fn(async () => undefined)
    }
    const deps = {
      logtoIdentity: identity,
      config: { PUBLIC_WEB_URL: 'https://app.example.test' }
    } as unknown as HttpDeps
    const app = Fastify()
    installZod(app)
    app.decorate('oidcAuth', async (req) => {
      req.oidcSubject = 'logto-user'
    })
    await app.register(meSocialIdentityRoutes(deps))

    try {
      const state = 's'.repeat(64)
      const authorization = await app.inject({
        method: 'POST',
        url: '/me/social-identities/authorization-uri',
        payload: { target: 'google', state }
      })
      expect(authorization.statusCode).toBe(200)
      expect(authorization.json()).toEqual({
        authorizationUri: 'https://accounts.example.test/authorize',
        connectorId: 'google-connector'
      })
      expect(identity.createSocialAuthorization).toHaveBeenCalledWith(
        'google',
        'https://app.example.test/auth/social/callback',
        state
      )

      const linked = await app.inject({
        method: 'POST',
        url: '/me/social-identities',
        payload: {
          connectorId: 'google-connector',
          connectorData: { code: 'provider-code', state, redirectUri: 'https://attacker.example.test/callback' }
        }
      })
      expect(linked.statusCode).toBe(200)
      expect(identity.linkSocialIdentity).toHaveBeenCalledWith('logto-user', 'google-connector', {
        code: 'provider-code',
        state,
        redirectUri: 'https://app.example.test/auth/social/callback'
      })

      const unlinked = await app.inject({ method: 'DELETE', url: '/me/social-identities/google' })
      expect(unlinked.statusCode).toBe(204)
      expect(identity.unlinkSocialIdentity).toHaveBeenCalledWith('logto-user', 'google')

      identity.unlinkSocialIdentity.mockRejectedValueOnce(
        new LogtoApiError('the last social sign-in method cannot be removed', 409, false, 'LAST_SOCIAL_IDENTITY')
      )
      const lastIdentity = await app.inject({ method: 'DELETE', url: '/me/social-identities/github' })
      expect(lastIdentity.statusCode).toBe(409)
      expect(lastIdentity.json()).toMatchObject({
        code: 'LAST_SOCIAL_IDENTITY',
        message: 'connect another sign-in method before removing this one'
      })
    } finally {
      await app.close()
    }
  })

  it('accepts slack as a linkable target, matching the console provider list', async () => {
    // The console offers Slack; a server-side allowlist that omitted it would
    // turn that Connect button into a 400.
    const identity = {
      createSocialAuthorization: vi.fn(async () => ({
        connectorId: 'slack-connector',
        redirectTo: 'https://slack.example.test/authorize'
      }))
    }
    const app = await slackApp({ logtoIdentity: identity } as unknown as HttpDeps)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/me/social-identities/authorization-uri',
        payload: { target: 'slack', state: 's'.repeat(64) }
      })
      expect(res.statusCode).toBe(200)
      expect(identity.createSocialAuthorization).toHaveBeenCalledWith(
        'slack',
        'https://app.example.test/auth/social/callback',
        's'.repeat(64)
      )
    } finally {
      await app.close()
    }
  })
})

/** A routes-only app whose oidcAuth stamps a fixed subject. */
async function slackApp(partial: Partial<HttpDeps>) {
  const deps = { ...partial, config: { PUBLIC_WEB_URL: 'https://app.example.test' } } as unknown as HttpDeps
  const app = Fastify()
  installZod(app)
  app.decorate('oidcAuth', async (req) => {
    req.oidcSubject = 'logto-user'
  })
  await app.register(meSocialIdentityRoutes(deps))
  return app
}

describe('GET /me/social-identities/slack', () => {
  it('returns the workspace identity behind the caller’s subject', async () => {
    const slackIdentityFor = vi.fn(async () => ({
      teamId: 'T0EXAMPLE1',
      userId: 'U0EXAMPLE1',
      teamName: 'Example Workspace'
    }))
    const app = await slackApp({ logtoIdentity: { slackIdentityFor } } as unknown as HttpDeps)
    try {
      const res = await app.inject({ method: 'GET', url: '/me/social-identities/slack' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        linked: true,
        teamId: 'T0EXAMPLE1',
        userId: 'U0EXAMPLE1',
        teamName: 'Example Workspace'
      })
      expect(slackIdentityFor).toHaveBeenCalledWith('logto-user')
    } finally {
      await app.close()
    }
  })

  it('reports "not linked" for an account that never connected Slack', async () => {
    const app = await slackApp({
      logtoIdentity: { slackIdentityFor: vi.fn(async () => null) }
    } as unknown as HttpDeps)
    try {
      const res = await app.inject({ method: 'GET', url: '/me/social-identities/slack' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ linked: false })
    } finally {
      await app.close()
    }
  })

  it('503s when the deployment cannot resolve identities, like its siblings', async () => {
    const app = await slackApp({} as unknown as HttpDeps)
    try {
      const res = await app.inject({ method: 'GET', url: '/me/social-identities/slack' })
      expect(res.statusCode).toBe(503)
    } finally {
      await app.close()
    }
  })

  it('502s when the provider is unreachable, rather than claiming "not linked"', async () => {
    const app = await slackApp({
      logtoIdentity: {
        slackIdentityFor: vi.fn(async () => {
          throw new LogtoApiError('logto unreachable', 0, true)
        })
      }
    } as unknown as HttpDeps)
    try {
      const res = await app.inject({ method: 'GET', url: '/me/social-identities/slack' })
      expect(res.statusCode).toBe(502)
    } finally {
      await app.close()
    }
  })
})

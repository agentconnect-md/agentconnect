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
})

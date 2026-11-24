import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { LogtoApiError } from '../../github/logto-identity.js'
import type { HttpDeps } from '../deps.js'
import { installZod } from '../plugins/zod.js'
import { meRoutes } from './me.js'

async function appWith(deleteUser: () => Promise<void>) {
  const user = {
    listAccountMemberships: vi.fn(async () => []),
    getProfile: vi.fn(async () => ({ userId: 'user-1', profilePictureUpdatedAt: null })),
    deleteAccount: vi.fn(async () => undefined)
  }
  const logtoIdentity = { deleteUser: vi.fn(deleteUser) }
  const deps = {
    repos: { user },
    logtoIdentity,
    clock: { now: () => 1_000_000 }
  } as unknown as HttpDeps
  const app = Fastify()
  installZod(app)
  app.decorate('humanAuth', async (req) => {
    req.principal = { userId: 'user-1' }
    req.oidcSubject = 'logto-user-1'
  })
  await app.register(meRoutes(deps))
  return { app, user, logtoIdentity }
}

describe('DELETE /me', () => {
  it('deletes the sign-in identity under the caller subject before the account row', async () => {
    const { app, user, logtoIdentity } = await appWith(async () => undefined)
    try {
      const res = await app.inject({ method: 'DELETE', url: '/me' })
      expect(res.statusCode).toBe(204)
      expect(logtoIdentity.deleteUser).toHaveBeenCalledWith('logto-user-1')
      expect(user.deleteAccount).toHaveBeenCalledWith('user-1', new Date(1_000_000), new Date(1_000_000 + 86_400_000))
    } finally {
      await app.close()
    }
  })

  it('keeps the account when the identity service cannot be reached', async () => {
    const { app, user } = await appWith(async () => {
      throw new LogtoApiError('logto unreachable', 0, true)
    })
    try {
      const res = await app.inject({ method: 'DELETE', url: '/me' })
      expect(res.statusCode).toBe(503)
      expect(user.deleteAccount).not.toHaveBeenCalled()
    } finally {
      await app.close()
    }
  })
})

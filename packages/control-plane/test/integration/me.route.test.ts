// The caller's profile keeps email immutable and supports replacing or restoring profile photos.
import { describe, it, expect, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp } from '../fakes/build-http.js'
import { DEFAULT_OWNER_ID, DEFAULT_OWNER_EMAIL } from '../../prisma/seed.js'
import type { IconStore } from '../../src/icons/icon-store.js'

interface MeBody {
  userId: string
  email: string | null
  name: string | null
  picture: string | null
  pictureCustom: boolean
  pictureUploadEnabled: boolean
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==',
  'base64'
)

describe('GET /me', () => {
  it('returns the seeded owner', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/me' })
      expect(res.statusCode).toBe(200)
      const body = res.json() as MeBody
      expect(body.userId).toBe(DEFAULT_OWNER_ID)
      expect(body.email).toBe(DEFAULT_OWNER_EMAIL)
    } finally {
      await close()
    }
  })
})

describe('PATCH /me', () => {
  it('updates the display name on the caller row', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/me', payload: { name: '  Example User  ' } })
      expect(res.statusCode).toBe(200)
      expect((res.json() as MeBody).name).toBe('Example User') // trimmed

      const row = await prisma.user.findUnique({ where: { id: DEFAULT_OWNER_ID } })
      expect(row?.displayName).toBe('Example User')
    } finally {
      await close()
    }
  })

  it('rejects any attempt to change the email — 400, nothing written', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const withName = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { name: 'Example User', email: 'attacker@example.test' }
      })
      expect(withName.statusCode).toBe(400)

      const emailOnly = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { email: 'attacker@example.test' }
      })
      expect(emailOnly.statusCode).toBe(400)

      const row = await prisma.user.findUnique({ where: { id: DEFAULT_OWNER_ID } })
      expect(row?.email).toBe(DEFAULT_OWNER_EMAIL)
      expect(row?.displayName).not.toBe('Example User') // the mixed request wrote nothing
    } finally {
      await close()
    }
  })

  it('rejects a picture write on PATCH (the avatar uses its dedicated upload route)', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        payload: { name: 'Example User', picture: 'https://attacker.example.test/x.png' }
      })
      expect(res.statusCode).toBe(400)
    } finally {
      await close()
    }
  })

  it('uploads and removes a custom profile photo without losing the OIDC fallback', async () => {
    const store: IconStore = {
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
      publicUrl: vi.fn((key, version) => `https://images.example.test/${key}?v=${version}`)
    }
    const { app, close } = buildHttpApp(prisma, {}, undefined, undefined, { iconStore: store })
    try {
      await prisma.user.update({
        where: { id: DEFAULT_OWNER_ID },
        data: { picture: 'https://idp.example.test/owner.png' }
      })

      const uploaded = await app.inject({
        method: 'PUT',
        url: '/api/v1/me/picture',
        headers: { 'content-type': 'image/png' },
        payload: PNG
      })
      expect(uploaded.statusCode).toBe(200)
      const uploadedBody = uploaded.json() as MeBody
      expect(uploadedBody.pictureCustom).toBe(true)
      expect(uploadedBody.pictureUploadEnabled).toBe(true)
      expect(uploadedBody.picture).toMatch(`https://images.example.test/icon/profiles/${DEFAULT_OWNER_ID}?v=`)
      expect(store.put).toHaveBeenCalledWith(`icon/profiles/${DEFAULT_OWNER_ID}`, PNG, 'image/png')

      const removed = await app.inject({ method: 'DELETE', url: '/api/v1/me/picture' })
      expect(removed.statusCode).toBe(200)
      expect((removed.json() as MeBody).picture).toBe('https://idp.example.test/owner.png')
      expect((removed.json() as MeBody).pictureCustom).toBe(false)
      expect(store.delete).toHaveBeenCalledWith(`icon/profiles/${DEFAULT_OWNER_ID}`)
    } finally {
      await close()
    }
  })

  it('rejects a blank name', async () => {
    const { app, close } = buildHttpApp(prisma)
    try {
      const res = await app.inject({ method: 'PATCH', url: '/api/v1/me', payload: { name: '   ' } })
      expect(res.statusCode).toBe(400)
    } finally {
      await close()
    }
  })
})

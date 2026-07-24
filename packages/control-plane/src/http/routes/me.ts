/**
 * `http/routes/me.ts` — the caller's own profile (C2, root surface like `/orgs`:
 * identity-scoped, outside the org boundary).
 *
 *   GET   /me → the signed-in user's profile
 *   PATCH  /me         → edit the display name. The body schema is STRICT: email
 *                        is immutable on this surface (the OIDC provider owns it).
 *   PUT    /me/picture → upload a custom profile photo when object storage is on.
 *   DELETE /me/picture → restore the OIDC-provider photo.
 *
 * An uploaded photo takes precedence over the OIDC `picture` claim. The latter
 * remains stored separately and becomes visible again when the custom photo is
 * removed, so a later sign-in cannot overwrite a user's explicit choice.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { UserProfileRecord } from '../../persistence/ports.js'
import { MeDto, UpdateMeBody, ErrorDto, type MeDtoT } from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'
import { profilePictureKey, resolveProfilePictureUrl } from '../../icons/icon-store.js'
import { validateIconUpload, MAX_ICON_BYTES } from '../../icons/icon-validate.js'

export function meRoutes(deps: HttpDeps) {
  return async function meRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    const toDto = (p: UserProfileRecord): MeDtoT => ({
      userId: p.userId,
      email: p.email,
      name: p.displayName,
      picture: resolveProfilePictureUrl(p.userId, p.picture, p.profilePictureUpdatedAt, deps.iconStore),
      pictureCustom: p.profilePictureUpdatedAt !== null,
      pictureUploadEnabled: !!deps.iconStore
    })

    r.get(
      '/me',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Get your profile',
          description: "The signed-in user's own profile: identity, display name, and avatar.",
          operationId: 'getMyProfile',
          response: { 200: MeDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const profile = await deps.repos.user.getProfile(req.principal!.userId)
        return profile
          ? toDto(profile)
          : reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'user not found' })
      }
    )

    r.patch(
      '/me',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Update your profile',
          description:
            'Edit your display name. Email remains managed by the sign-in provider; profile photos use the dedicated upload endpoint.',
          operationId: 'updateMyProfile',
          body: UpdateMeBody,
          response: { 200: MeDto, 400: ErrorDto, 404: ErrorDto }
        }
      },
      async (req) => {
        // P2025 (row gone) maps to 404 in the server error mapper.
        const updated = await deps.repos.user.updateProfile(req.principal!.userId, { displayName: req.body.name })
        return toDto(updated)
      }
    )

    // Profile-photo uploads use the same strict raster validation and bounded
    // object-store path as agent/org icons. The parser is only installed with the
    // routes, avoiding a raw-image surface when storage is disabled.
    const iconStore = deps.iconStore
    if (!iconStore) return
    app.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_ICON_BYTES },
      (_req, body, done) => done(null, body)
    )

    r.put(
      '/me/picture',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Upload your profile photo',
          description:
            'Store a PNG, JPEG, or WebP photo for your profile. The image replaces the sign-in provider photo until removed.',
          operationId: 'uploadMyProfilePicture',
          consumes: ['image/png', 'image/jpeg', 'image/webp'],
          body: z.any(),
          response: { 200: MeDto, 404: ErrorDto, 413: ErrorDto, 415: ErrorDto }
        }
      },
      async (req, reply) => {
        const bytes = req.body as Buffer
        const validation = validateIconUpload(bytes)
        if (!validation.ok) {
          return reply
            .code(validation.status)
            .send({ error: 'Unsupported', statusCode: validation.status, message: validation.message })
        }
        const userId = req.principal!.userId
        await iconStore.put(profilePictureKey(userId), bytes, validation.contentType)
        const updated = await deps.repos.user.setProfilePicture(userId, new Date())
        return toDto(updated)
      }
    )

    r.delete(
      '/me/picture',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.Profile],
          summary: 'Remove your profile photo',
          description: 'Remove the uploaded photo and restore the avatar from your sign-in provider.',
          operationId: 'deleteMyProfilePicture',
          response: { 200: MeDto, 404: ErrorDto }
        }
      },
      async (req) => {
        const userId = req.principal!.userId
        const updated = await deps.repos.user.clearProfilePicture(userId)
        await iconStore.delete(profilePictureKey(userId)).catch((err) => {
          app.log.warn({ err, userId }, 'profile picture store delete failed (profile already reset)')
        })
        return toDto(updated)
      }
    )
  }
}

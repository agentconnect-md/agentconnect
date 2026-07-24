/**
 * `http/routes/me-keys.ts` — the caller's own personal API keys (C2, root surface
 * like `/me`: identity-scoped, outside the org boundary).
 *
 *   GET    /me/keys        → active keys you own, across all your orgs (never the secret/hash)
 *   POST   /me/keys        → mint a key in ONE of your orgs (default 90-day expiry); plaintext once
 *   DELETE /me/keys/:id     → revoke one of your own keys (kill switch)
 *
 * A personal key acts as YOU, with your role, in the org it was minted for
 * (daemon-api-key-auth.md §8) — permissions are per-org, so every key names an org.
 * These routes are identity-scoped (no `/orgs/:orgId` prefix); the create body
 * carries the target org, verified against the caller's membership.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { UserApiKeyView } from '../../ports.js'
import {
  UserApiKeyListDto,
  UserApiKeyDto,
  MintedUserKeyDto,
  CreateUserKeyBody,
  IdParam,
  ErrorDto,
  type UserApiKeyDtoT
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

function toDto(v: UserApiKeyView): UserApiKeyDtoT {
  return {
    id: v.id,
    displayTail: v.displayTail,
    name: v.name,
    orgId: v.orgId,
    orgSlug: v.orgSlug,
    orgName: v.orgName,
    createdAt: v.createdAt.toISOString(),
    lastUsedAt: v.lastUsedAt ? v.lastUsedAt.toISOString() : null,
    expiresAt: v.expiresAt ? v.expiresAt.toISOString() : null,
    revokedAt: v.revokedAt ? v.revokedAt.toISOString() : null
  }
}

export function meKeyRoutes(deps: HttpDeps) {
  return async function meKeyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/me/keys',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'List your API keys',
          description:
            'Your active personal API keys across every organization you belong to, never exposing the secret or its hash.',
          operationId: 'listMyApiKeys',
          response: { 200: UserApiKeyListDto }
        }
      },
      async (req) => {
        const rows = await deps.apiKeys.listForUser(req.principal!.userId)
        return rows.map(toDto)
      }
    )

    r.post(
      '/me/keys',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'Create an API key',
          description:
            'Mints a personal API key in one of your organizations (default 90-day expiry; pass `expiresInDays: null` for a non-expiring key). The key acts as you, with your role in that org. The plaintext is returned exactly once and is never retrievable afterward.',
          operationId: 'createMyApiKey',
          body: CreateUserKeyBody,
          response: { 201: MintedUserKeyDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        // A personal key must not be able to mint more keys — a leaked key can't
        // self-propagate new credentials (it can only ever act, then be revoked).
        if (req.apiKeyId) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'API keys cannot create API keys' })
        }
        // The target org must be one the caller actually belongs to — otherwise it
        // isn't theirs to mint against (reads as absent, like any foreign org).
        const role = await deps.repos.org.roleOf(req.body.orgId, req.principal!.userId)
        if (!role) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'organization not found' })
        }
        const minted = await deps.apiKeys.mintForUser({
          userId: req.principal!.userId,
          orgId: req.body.orgId,
          ...(req.body.name ? { name: req.body.name } : {}),
          expiresInDays: req.body.expiresInDays
        })
        return reply.code(201).send({
          apiKeyId: minted.apiKeyId,
          apiKey: minted.token,
          displayTail: minted.displayTail
        })
      }
    )

    r.delete(
      '/me/keys/:id',
      {
        preHandler: app.humanAuth,
        schema: {
          tags: [Tag.ApiKeys],
          summary: 'Revoke an API key',
          description:
            'Revokes one of your own API keys as a kill switch; the next request presenting it is rejected. A key id that isn’t yours reads as absent (404).',
          operationId: 'revokeMyApiKey',
          params: IdParam,
          response: { 200: UserApiKeyDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        // Ownership: only the caller's OWN keys are revocable — a foreign (or
        // unknown) key id must read as absent, never get revoked (cross-user kill).
        const owned = await deps.apiKeys.listForUser(req.principal!.userId, { includeRevoked: true })
        const target = owned.find((k) => k.id === req.params.id)
        if (!target) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'key not found' })
        }
        if (target.revokedAt) return toDto(target) // already revoked → no-op, no second audit write
        const revoked = await deps.apiKeys.revoke(req.params.id, 'revoked by user')
        // `revoke` returns the base view (no org fields) — merge the fresh revokedAt
        // onto the org-labeled row we already have.
        return toDto({ ...target, revokedAt: revoked.revokedAt })
      }
    )
  }
}

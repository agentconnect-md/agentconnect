/**
 * `http/routes/keys.ts` — per-daemon API-key management (C2, authenticated console ops).
 *
 *   GET    /daemons/:id/keys              → list a daemon's keys (never the secret/hash)
 *   POST   /daemons/:id/keys              → mint an additional key (rotate / "Regenerate")
 *   DELETE /daemons/:id/keys/:keyId       → revoke a key (kill switch)
 *
 * Minting returns the one-time plaintext + a ready-to-run start command. A missing key on
 * revoke maps to 404 via the Prisma-P2025 branch in the error handler.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { ApiKeyView } from '../../ports.js'
import { DaemonId } from '../../domain/ids.js'
import { denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit } from '../../authorization/policy.js'
import { ApiKeyListDto, MintedKeyDto, ApiKeyDto, IdParam, ErrorDto, type ApiKeyDtoT } from '../dto/index.js'
import { daemonStartCommand, daemonWsUrl } from '../onboarding.js'
import { Tag } from '../plugins/openapi.js'

const KeyParam = z.object({ id: z.string(), keyId: z.string() })

function toDto(v: ApiKeyView): ApiKeyDtoT {
  return {
    id: v.id,
    displayTail: v.displayTail,
    name: v.name,
    createdAt: v.createdAt.toISOString(),
    lastUsedAt: v.lastUsedAt ? v.lastUsedAt.toISOString() : null,
    expiresAt: v.expiresAt ? v.expiresAt.toISOString() : null,
    revokedAt: v.revokedAt ? v.revokedAt.toISOString() : null
  }
}

export function keyRoutes(deps: HttpDeps) {
  return async function keyRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Keys are a DERIVED resource — they inherit the parent daemon's visibility.
    // Resolve the daemon and require it be in the caller's org AND visible to them;
    // a cross-org OR restricted-away daemon both read as absent (404). Minting /
    // revoking a daemon's enrollment credential is a credential write, so the
    // handlers additionally gate on canEdit.
    const getOrgDaemon = async (req: FastifyRequest, id: string) => {
      const view = await deps.registry.get(DaemonId(id))
      if (!view || view.orgId !== req.orgCtx!.orgId) return null
      return canView(view, ctxOf(req)) ? view : null
    }

    r.get(
      '/daemons/:id/keys',
      {
        schema: {
          tags: [Tag.DaemonKeys],
          summary: 'List a daemon’s keys',
          description: 'Lists a daemon’s API keys, never exposing the secret or its hash.',
          operationId: 'listDaemonKeys',
          params: IdParam,
          response: { 200: ApiKeyListDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!(await getOrgDaemon(req, req.params.id))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        const rows = await deps.apiKeys.listForDaemon(DaemonId(req.params.id))
        return rows.map(toDto)
      }
    )

    // Mint an additional key for an existing daemon (overlap rotation, or "Regenerate"
    // for an offline/pending daemon). Returns the one-time plaintext + start command.
    r.post(
      '/daemons/:id/keys',
      {
        schema: {
          tags: [Tag.DaemonKeys],
          summary: 'Issue a daemon key',
          description:
            'Mints an additional API key for an existing daemon (overlap rotation or "Regenerate"), returning the one-time plaintext and a ready-to-run start command.',
          operationId: 'issueDaemonKey',
          params: IdParam,
          response: { 201: MintedKeyDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const view = await getOrgDaemon(req, req.params.id)
        if (!view) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (!canEdit(view, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this daemon' })
        }
        const minted = await deps.apiKeys.mintForDaemon(DaemonId(req.params.id))
        const command = daemonStartCommand(daemonWsUrl(deps.config), minted.token, deps.config.DAEMON_DIST_TAG)
        return reply.code(201).send({
          apiKeyId: minted.apiKeyId,
          apiKey: minted.token,
          displayTail: minted.displayTail,
          command
        })
      }
    )

    r.delete(
      '/daemons/:id/keys/:keyId',
      {
        schema: {
          tags: [Tag.DaemonKeys],
          summary: 'Revoke a daemon key',
          description:
            'Revokes one of a daemon’s API keys as a kill switch; a key from another daemon or org reads as absent (404).',
          operationId: 'revokeDaemonKey',
          params: KeyParam,
          response: { 200: ApiKeyDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const daemon = await getOrgDaemon(req, req.params.id)
        if (!daemon) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'daemon not found' })
        }
        if (!canEdit(daemon, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this daemon' })
        }
        // Bind the keyId to the org-checked daemon — a raw key id from ANOTHER
        // daemon/org must read as absent, not get revoked (cross-tenant kill).
        const owned = await deps.apiKeys.listForDaemon(DaemonId(req.params.id))
        if (!owned.some((k) => k.id === req.params.keyId)) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'key not found' })
        }
        const view = await deps.apiKeys.revoke(req.params.keyId, 'revoked via console')
        // Kill the revoked credential's relay reach immediately (§9 revocation loop): every
        // relay drops this daemon's rd/* connection and re-verifies on its next hello.
        deps.relayControl.daemonRevoke(req.params.id)
        return toDto(view)
      }
    )
  }
}

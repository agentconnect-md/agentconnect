/**
 * `http/routes/icon-upload.ts` — uploaded-icon write surface (docs/designs/icon-uploads.md).
 *
 * Org-scoped, mounted ONLY when the object store is configured (`deps.iconStore`);
 * absent ⇒ these routes don't exist and the console hides the Upload button.
 *
 *   PUT    /agents/:agentId/icon  → store an uploaded avatar (agent-edit authz)
 *   DELETE /agents/:agentId/icon  → drop it, reset to a random glyph
 *   PUT    /icon                  → the ORG's uploaded icon (owner-only)
 *   DELETE /icon
 *
 * The CP proxies the upload (browser → CP → store): the raw `image/*` body is
 * sniffed here (magic bytes; SVG rejected) so the client `Content-Type` is never
 * trusted, then written to the store under the owner's stable key. The agent/org
 * row keeps an image descriptor; each agent upload gets an opaque generation so
 * detached platform-profile updates can distinguish rapid overwrites.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId, type OrgId } from '../../domain/ids.js'
import { canEdit } from '../../authorization/policy.js'
import { ctxOf, denyNonOwner, orgOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { AgentIconDto, ErrorDto } from '../dto/index.js'
import { agentIconKey, orgIconKey } from '../../icons/icon-store.js'
import { validateIconUpload, MAX_ICON_BYTES } from '../../icons/icon-validate.js'
import { randomGlyphIcon, resolveAgentIconUrl, resolveOrgIconUrl, type IconUrlBases } from '../../agents/agent-icon.js'
import { syncAgentBotIcons } from '../agent-bot-icon-sync.js'

const IconResultDto = z.object({
  icon: AgentIconDto,
  /** The stored image's public URL (cache-busted), or null after a delete. */
  iconUrl: z.string().nullable()
})

export function iconUploadRoutes(deps: HttpDeps) {
  return async function iconUploadRoutesPlugin(app: FastifyInstance): Promise<void> {
    const iconStore = deps.iconStore
    if (!iconStore) return // not configured — routes not mounted (defensive; caller also gates)
    const r = app.withTypeProvider<ZodTypeProvider>()

    const iconBases: IconUrlBases = {
      ...(deps.config.PUBLIC_CP_URL ? { cp: deps.config.PUBLIC_CP_URL } : {}),
      ...(deps.config.S3_PUBLIC_BASE_URL ? { store: deps.config.S3_PUBLIC_BASE_URL } : {})
    }

    // Buffer the raw image body ourselves (no JSON here). Encapsulated to this
    // plugin, so it doesn't affect the org scope's JSON routes. The size cap is
    // enforced per-route via `bodyLimit`; this parser just hands over the bytes.
    app.addContentTypeParser(
      ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_ICON_BYTES },
      (_req, body, done) => done(null, body)
    )

    // Best-effort: replicate the agent's new icon to every daemon serving it so the
    // Slack per-message avatar refreshes now (the reconnect roster is the backstop).
    const replicateAgent = async (orgId: OrgId, agentId: string): Promise<void> => {
      const agent = await deps.repos.agent.get(orgId, AgentId(agentId))
      if (!agent) return
      await deps.agentDelivery.upsert(agent, (err, daemonId) => {
        app.log.warn({ err, agentId, daemonId }, 'icon replicate agent/upsert failed (backstop: reconnect roster)')
      })
    }

    // ── Agent icon ────────────────────────────────────────────────────────────
    r.put(
      '/agents/:agentId/icon',
      {
        config: { bodyLimit: MAX_ICON_BYTES },
        schema: {
          tags: [Tag.Agents],
          summary: 'Upload an agent icon',
          description:
            'Store a user-uploaded avatar (PNG/JPEG/WebP) for the agent and set its icon to `image`. Owner/editor only.',
          operationId: 'uploadAgentIcon',
          params: z.object({ agentId: z.string().uuid() }),
          consumes: ['image/png', 'image/jpeg', 'image/webp'],
          body: z.any(),
          response: { 200: IconResultDto, 403: ErrorDto, 404: ErrorDto, 413: ErrorDto, 415: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // Built-in preset agents keep the fixed brand icon (preset-agents.md §3.1).
        if (agent.builtin) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'built-in agent icon cannot be changed' })
        }
        const bytes = req.body as Buffer
        const v = validateIconUpload(bytes)
        if (!v.ok) return reply.code(v.status).send({ error: 'Unsupported', statusCode: v.status, message: v.message })

        await iconStore.put(agentIconKey(agent.id), bytes, v.contentType)
        const imageIcon = { kind: 'image' as const, generation: randomUUID() }
        const updated = await deps.repos.agent.update(orgOf(req), AgentId(agent.id), {
          icon: imageIcon,
          ...(req.principal?.userId ? { lastModifiedByUserId: req.principal.userId } : {})
        })
        void replicateAgent(agent.orgId, agent.id)
        void syncAgentBotIcons(deps, updated, app.log)
        void deps.gitlab?.accounts.syncAgentAvatars(agent.orgId, agent.id)
        return reply.send({
          icon: { kind: 'image' as const },
          iconUrl: resolveAgentIconUrl(agent.id, imageIcon, iconBases, updated.lastModifiedAt.getTime())
        })
      }
    )

    r.delete(
      '/agents/:agentId/icon',
      {
        schema: {
          tags: [Tag.Agents],
          summary: 'Delete an agent icon',
          description: 'Remove the uploaded avatar and reset the agent to a random glyph. Owner/editor only.',
          operationId: 'deleteAgentIcon',
          params: z.object({ agentId: z.string().uuid() }),
          response: { 200: IconResultDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(req.params.agentId))
        if (!agent) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'agent not found' })
        }
        if (!canEdit(agent, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot edit this agent' })
        }
        // Built-in preset agents keep the fixed brand icon (preset-agents.md §3.1).
        if (agent.builtin) {
          return reply
            .code(403)
            .send({ error: 'Forbidden', statusCode: 403, message: 'built-in agent icon cannot be changed' })
        }
        const glyph = randomGlyphIcon()
        const updated = await deps.repos.agent.update(orgOf(req), AgentId(agent.id), {
          icon: glyph,
          ...(req.principal?.userId ? { lastModifiedByUserId: req.principal.userId } : {})
        })
        await iconStore.delete(agentIconKey(agent.id)).catch((err) => {
          app.log.warn({ err, agentId: agent.id }, 'icon store delete failed (row already reset)')
        })
        void replicateAgent(agent.orgId, agent.id)
        void syncAgentBotIcons(deps, updated, app.log)
        void deps.gitlab?.accounts.syncAgentAvatars(agent.orgId, agent.id)
        return reply.send({ icon: glyph, iconUrl: null })
      }
    )

    // ── Org icon (owner-only; console-only, never fed to Slack) ─────────────────
    r.put(
      '/icon',
      {
        config: { bodyLimit: MAX_ICON_BYTES },
        schema: {
          tags: [Tag.Organizations],
          summary: 'Upload the organization icon',
          description:
            'Store a user-uploaded icon (PNG/JPEG/WebP) for the org and set its icon to `image`. Owner only.',
          operationId: 'uploadOrganizationIcon',
          consumes: ['image/png', 'image/jpeg', 'image/webp'],
          body: z.any(),
          response: { 200: IconResultDto, 403: ErrorDto, 413: ErrorDto, 415: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const bytes = req.body as Buffer
        const v = validateIconUpload(bytes)
        if (!v.ok) return reply.code(v.status).send({ error: 'Unsupported', statusCode: v.status, message: v.message })

        const orgId = req.orgCtx!.orgId
        await iconStore.put(orgIconKey(orgId), bytes, v.contentType)
        const updated = await deps.repos.org.setIcon(orgId, { kind: 'image' })
        return reply.send({
          icon: { kind: 'image' as const },
          iconUrl: resolveOrgIconUrl(orgId, { kind: 'image' }, iconBases, updated.updatedAt.getTime())
        })
      }
    )

    r.delete(
      '/icon',
      {
        schema: {
          tags: [Tag.Organizations],
          summary: 'Delete the organization icon',
          description: 'Remove the uploaded org icon and reset it to a generated default. Owner only.',
          operationId: 'deleteOrganizationIcon',
          response: { 200: IconResultDto, 403: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const orgId = req.orgCtx!.orgId
        const glyph = randomGlyphIcon()
        await deps.repos.org.setIcon(orgId, glyph)
        await iconStore.delete(orgIconKey(orgId)).catch((err) => {
          app.log.warn({ err, orgId }, 'org icon store delete failed (row already reset)')
        })
        return reply.send({ icon: glyph, iconUrl: null })
      }
    )
  }
}

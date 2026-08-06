import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { AgentId } from '../../domain/ids.js'
import { renderAgentIconPng } from '../../agents/agent-icon-render.js'
import { agentIconKey, joinPublicUrl } from '../../icons/icon-store.js'

/**
 * Public, unauthenticated agent avatar: `GET /v1/agents/:id/icon` → a PNG of the
 * agent's current icon (runtime mark / glyph+color; `image` icons redirect to
 * their own URL). Slack fetches this as the per-message `icon_url`
 * (chat:write.customize), so it must be reachable with NO bearer, and it carries
 * only the rendered avatar — no other agent data. Mounted at the version root
 * (NOT org-scoped — Slack has only the agent UUID, not the org) and again at the
 * public `/v1` alias, the same placement as the OAuth callbacks. The `?v=` the CP
 * appends is a Slack cache-buster; the content ignores it.
 */
export function agentIconRoutes(deps: HttpDeps) {
  return async function agentIconRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.get(
      '/agents/:id/icon',
      {
        schema: {
          hide: true,
          params: z.object({ id: z.string().uuid() }),
          querystring: z.object({ v: z.string().optional() })
        }
      },
      async (req, reply): Promise<FastifyReply> => {
        // Public by design: chat platforms (Slack icon_url, Lark's launcher)
        // fetch this PNG with no credentials, so there is no org principal to
        // fence on — the raw agent UUID is the capability.
        // eslint-disable-next-line no-restricted-syntax -- org-scoped-data-layer.md §4: public-by-design endpoint
        const agent = await deps.repos.agent.getUnscoped(AgentId(req.params.id)).catch(() => null)
        if (!agent) return reply.code(404).send()
        // Lark's app launcher loads this with `crossOrigin = "anonymous"` before
        // rasterizing it on a canvas, so the public image response must allow CORS.
        reply.header('Access-Control-Allow-Origin', '*')
        // `image` icons live in the object store — iconUrl points straight at the
        // store's public URL, so Slack/browsers normally never hit this endpoint for
        // them. Redirect if reached anyway (when a store base is configured); if it
        // isn't, fall through to the glyph/runtime render as a graceful default.
        if (agent.icon?.kind === 'image' && deps.config.S3_PUBLIC_BASE_URL) {
          const url = joinPublicUrl(
            deps.config.S3_PUBLIC_BASE_URL,
            agentIconKey(agent.id),
            agent.lastModifiedAt.getTime()
          )
          return reply.redirect(url, 302)
        }
        let png: Buffer
        try {
          png = await renderAgentIconPng(agent.icon?.kind === 'image' ? null : agent.icon, agent.runtime)
        } catch (err) {
          req.log.error({ err }, 'agent icon render failed')
          return reply.code(500).send()
        }
        return (
          reply
            .header('Content-Type', 'image/png')
            // CP-served render: pin the type so a browser can't sniff it to anything else.
            .header('X-Content-Type-Options', 'nosniff')
            // Public + cacheable; the icon URL is cache-busted by `?v=` on change.
            .header('Cache-Control', 'public, max-age=300')
            .send(png)
        )
      }
    )
  }
}

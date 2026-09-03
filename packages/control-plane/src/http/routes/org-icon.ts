import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { buildAgentIconSvg, ICON_RENDER_FONT } from '../../agents/agent-icon-render.js'
import { defaultOrgGlyphIcon } from '../../agents/agent-icon.js'
import { orgIconKey, joinPublicUrl } from '../../icons/icon-store.js'

/**
 * Public, unauthenticated org avatar: `GET /v1/orgs/:id/icon` → a PNG of the org's
 * current icon (glyph plate; `image` icons redirect to the object-store public URL).
 * The console renders it as `<img src>`, which can't send a bearer — an org logo
 * isn't sensitive. Mirrors the agent icon endpoint (version root + `/v1` alias). A
 * legacy org with no stored icon renders a deterministic glyph keyed off its id.
 */
export function orgIconRoutes(deps: HttpDeps) {
  return async function orgIconRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    r.get(
      '/orgs/:id/icon',
      {
        schema: {
          hide: true,
          params: z.object({ id: z.string() }),
          querystring: z.object({ v: z.string().optional() })
        }
      },
      async (req, reply): Promise<FastifyReply> => {
        const row = await deps.repos.org.iconById(req.params.id).catch(() => null)
        if (!row) return reply.code(404).send()
        const icon = row.icon ?? defaultOrgGlyphIcon(req.params.id)
        if (icon.kind === 'image' && deps.config.S3_PUBLIC_BASE_URL) {
          const url = joinPublicUrl(deps.config.S3_PUBLIC_BASE_URL, orgIconKey(req.params.id), row.updatedAt.getTime())
          return reply.redirect(url, 302)
        }
        // No runtime for orgs — an `image` icon with no store base degrades to the
        // deterministic default glyph rather than a runtime mark.
        const svg = buildAgentIconSvg(icon.kind === 'image' ? defaultOrgGlyphIcon(req.params.id) : icon, '')
        let png: Buffer
        try {
          const { Resvg } = await import('@resvg/resvg-js')
          png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 }, font: ICON_RENDER_FONT }).render().asPng()
        } catch (err) {
          req.log.error({ err }, 'org icon render failed')
          return reply.code(500).send()
        }
        return reply
          .header('Content-Type', 'image/png')
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cache-Control', 'public, max-age=300')
          .send(png)
      }
    )
  }
}

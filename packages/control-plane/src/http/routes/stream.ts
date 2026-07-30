/**
 * `http/routes/stream.ts` (design §2.1) — `GET /orgs/:orgId/stream` Server-Sent
 * Events. The WebUI live feed relays converged session milestones and body-free
 * transcript invalidations — filtered to the PATH org's daemons, so one tenant
 * never sees another's session activity.
 *
 * SSE is written on the raw response (`reply.hijack()`), so this route opts out
 * of zod response serialization. The subscription is torn down when the client
 * disconnects, and a periodic comment keeps the connection alive through proxies.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { HttpDeps } from '../deps.js'
import type { SessionEventEnvelope } from '../../events/sink.js'
import { Tag } from '../plugins/openapi.js'
import { ctxOf } from '../rbac.js'
import {
  canView,
  canViewSession,
  identitySetOf,
  type SessionViewable,
  type Shareable,
  type ViewCtx
} from '../../authorization/policy.js'
import { AgentId, DaemonId, SessionId, type OrgId } from '../../domain/ids.js'

const KEEPALIVE_MS = 25_000

export function canStreamAgent(agent: (Shareable & { orgId: OrgId }) | null, orgId: OrgId, ctx: ViewCtx): boolean {
  // `canView` assumes its caller already selected the current tenant. This org
  // check applies before the resource policy for every role.
  return !!agent && agent.orgId === orgId && canView(agent, ctx)
}

/**
 * Session-level gate for the live feed (session-visibility.md §5). BOTH envelope
 * variants are session-scoped and both must pass it: the milestone carries a
 * content-derived `summary`, and the activity invalidation still exposes the
 * session's existence, revision, and live activity.
 *
 * A row that cannot be read is dropped — an activity event whose milestone never
 * committed has no visibility to check, so fail closed like the agent arm does.
 */
export function canStreamSession(
  session: SessionViewable | null,
  ctx: ViewCtx,
  identitySet: ReadonlySet<string>
): boolean {
  return !!session && canViewSession(session, ctx, identitySet)
}

function writeEvent(reply: FastifyReply, envelope: SessionEventEnvelope): void {
  const activity = envelope.activity
  const payload = JSON.stringify(
    activity ? { daemonId: envelope.daemonId, activity } : { daemonId: envelope.daemonId, event: envelope.event }
  )
  reply.raw.write(`event: ${activity ? 'session-activity' : 'session'}\n`)
  reply.raw.write(`data: ${payload}\n\n`)
}

export function streamRoutes(deps: HttpDeps) {
  return async function streamRoutesPlugin(app: FastifyInstance): Promise<void> {
    app.get(
      '/stream',
      {
        schema: {
          tags: [Tag.Stream],
          summary: 'Live session event stream',
          description:
            'Server-sent event feed relaying session milestones and body-free transcript activity for the org’s daemons.',
          operationId: 'streamSessionEvents'
        }
      },
      async (req, reply) => {
        reply.headers({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        // Hijacking skips Fastify's normal send path, so flush every pending
        // header (including CORS/Vary from onRequest hooks) to the raw response.
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value)
        }
        reply.raw.writeHead(200)
        // Hand the socket to us — Fastify will not try to serialize/close it.
        reply.hijack()

        const orgId = req.orgCtx!.orgId
        const ctx = ctxOf(req)
        // daemonId → belongs-to-this-org, memoized per connection (events arrive
        // in bursts from the same few daemons; one registry lookup each).
        const daemonOrg = new Map<string, boolean>()
        const inOrg = async (daemonId: string): Promise<boolean> => {
          const cached = daemonOrg.get(daemonId)
          if (cached !== undefined) return cached
          const view = await deps.registry.get(DaemonId(daemonId)).catch(() => null)
          const ok = !!view && view.orgId === orgId
          daemonOrg.set(daemonId, ok)
          return ok
        }
        // agentId → visible-to-this-caller, memoized per connection. The milestone's
        // `summary` is content-derived, so a restricted agent the caller can't see is
        // dropped WHOLE (§5.5 option 1: existence hidden).
        const agentVisible = new Map<string, boolean>()
        const canSeeAgent = async (agentId: string): Promise<boolean> => {
          const cached = agentVisible.get(agentId)
          if (cached !== undefined) return cached
          const agent = await deps.repos.agent.get(AgentId(agentId)).catch(() => null)
          const ok = canStreamAgent(agent, orgId, ctx)
          agentVisible.set(agentId, ok)
          return ok
        }

        // Session visibility is deliberately NOT memoized: a §4.3 tightening must
        // hide the session from a live subscriber at commit, and a long-lived SSE
        // connection holding a cached verdict would keep leaking it. Sessions are
        // per-event unique anyway, so a cache would rarely hit.
        const identitySet = identitySetOf(ctx)
        const canSeeSession = async (sessionId: string): Promise<boolean> => {
          const session = await deps.repos.session.get(SessionId(sessionId)).catch(() => null)
          return canStreamSession(session, ctx, identitySet)
        }

        const unsubscribe = deps.events.subscribe((envelope) => {
          void (async () => {
            if (!(await inOrg(envelope.daemonId))) return
            const agentId = envelope.activity?.agentId ?? envelope.event?.agentId
            if (!agentId || !(await canSeeAgent(agentId))) return
            const sessionId = envelope.activity?.sessionId ?? envelope.event?.sessionId
            if (!sessionId || !(await canSeeSession(sessionId))) return
            writeEvent(reply, envelope)
          })()
        })
        const keepalive = setInterval(() => reply.raw.write(`: keepalive\n\n`), KEEPALIVE_MS)

        const cleanup = (): void => {
          clearInterval(keepalive)
          unsubscribe()
        }
        req.raw.on('close', cleanup)
        reply.raw.on('close', cleanup)

        // Open the stream immediately so clients know they're connected.
        reply.raw.write(`: connected\n\n`)
      }
    )
  }
}

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
import { canViewSession, type SessionViewable, type ViewCtx } from '../../authorization/policy.js'
import type { SessionExternalAccessSnapshot } from '../../persistence/ports.js'
import { makeSessionAccessResolver } from '../session-access.js'
import { DaemonId, SessionId, type OrgId } from '../../domain/ids.js'

const KEEPALIVE_MS = 25_000

/**
 * Session-level gate for the live feed (session-visibility.md §5). Every envelope
 * variant is session-scoped and must pass it: the milestone carries a
 * content-derived `summary`, and the activity invalidation and wait-state change
 * still expose the session's existence, revision, and live activity.
 *
 * A row that cannot be read is dropped — an activity event whose milestone never
 * committed has no visibility to check, so it fails closed.
 */
export function canStreamSession(
  session: (SessionViewable & { orgId: OrgId }) | null,
  orgId: OrgId,
  ctx: ViewCtx,
  identitySet: ReadonlySet<string>,
  externalAccess?: SessionExternalAccessSnapshot
): boolean {
  return !!session && session.orgId === orgId && canViewSession(session, ctx, identitySet, externalAccess)
}

function writeEvent(reply: FastifyReply, envelope: SessionEventEnvelope): void {
  const { daemonId, activity, state } = envelope
  const payload = activity ? { daemonId, activity } : state ? { daemonId, state } : { daemonId, event: envelope.event }
  reply.raw.write(`event: ${activity ? 'session-activity' : state ? 'session-state' : 'session'}\n`)
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function streamRoutes(deps: HttpDeps) {
  return async function streamRoutesPlugin(app: FastifyInstance): Promise<void> {
    const sessionAccess = makeSessionAccessResolver(deps)
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
        const connectedCtx = ctxOf(req)
        // daemonId → available to this org, memoized per connection; shared pool members qualify.
        const daemonOrg = new Map<string, boolean>()
        const inOrg = async (daemonId: string): Promise<boolean> => {
          const cached = daemonOrg.get(daemonId)
          if (cached !== undefined) return cached
          const view = await deps.registry.getAvailable(orgId, DaemonId(daemonId)).catch(() => null)
          const ok = !!view
          daemonOrg.set(daemonId, ok)
          return ok
        }
        // Organization membership is a live authorization input. Do not pin it
        // to connection-open state: removing a member must stop this already-open
        // stream on its next event.
        const currentCtx = async (): Promise<ViewCtx | null> => {
          const role = await deps.repos.org.roleOf(orgId, connectedCtx.userId).catch(() => null)
          return role ? { userId: connectedCtx.userId, role } : null
        }

        // Session visibility is deliberately NOT memoized: a §4.3 tightening must
        // hide the session from a live subscriber at commit, and a long-lived SSE
        // connection holding a cached verdict would keep leaking it. Sessions are
        // per-event unique anyway, so a cache would rarely hit. The identity set
        // gets the SAME treatment: unlinking Slack shrinks an authorization set,
        // and a connection-fixed copy would keep serving the unlinked identity's
        // private DMs for the socket's lifetime. Re-resolving here is a memory
        // read in the common case (LogtoIdentityService caches per subject,
        // single-flight) and the unlink path invalidates that cache, so the
        // revocation lands on the next event, not the next connection.
        const canSeeSession = async (agentId: string, sessionId: string, ctx: ViewCtx): Promise<boolean> => {
          const session = await deps.repos.session.get(orgId, SessionId(sessionId)).catch(() => null)
          if (!session || session.agentId !== agentId) return false
          const access = await sessionAccess.forSessions(req, [session]).catch(() => null)
          return !!access && canStreamSession(session, orgId, ctx, access.identitySet, access.externalAccess)
        }

        const unsubscribe = deps.events.subscribe((envelope) => {
          void (async () => {
            if (!(await inOrg(envelope.daemonId))) return
            const ctx = await currentCtx()
            if (!ctx) return
            const agentId = envelope.activity?.agentId ?? envelope.state?.agentId ?? envelope.event?.agentId
            const sessionId = envelope.activity?.sessionId ?? envelope.state?.sessionId ?? envelope.event?.sessionId
            if (!agentId || !sessionId || !(await canSeeSession(agentId, sessionId, ctx))) return
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

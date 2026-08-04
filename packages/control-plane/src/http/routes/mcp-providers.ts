/**
 * `http/routes/mcp-providers.ts` (design docs/designs/centralized-tool-management.md §4-§7)
 * — CRUD for org-level MCP providers. A provider is an upstream MCP server the CP
 * proxies to agents through a relay: agents receive a proxy URL + grant key, never
 * the upstream url/credential.
 *
 * SECRET DISCIPLINE (mirrors integrations/bots): the upstream auth header VALUES live
 * only in `McpProviderSecretStore` and the plaintext bearer grant key only in
 * `McpGrantRepo` — neither ever rides a DTO or a log. The create response echoes the
 * minted grant key EXACTLY ONCE (like a personal API key). The `url` passes a static
 * SSRF gate here (the relay does the authoritative DNS-time guard on every call).
 *
 * v1 policy: `transport:'http'` only, `visibility:'org'` only, exactly one active
 * grant per provider. The daemon/relay push (double-push of proxy def + rc/mcp-assign)
 * is wired in a later step; this file is the persistence + REST edge.
 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import type { McpProviderRecord, McpHeader, McpGrantRepo } from '../../persistence/ports.js'
import type { OrgId } from '../../domain/ids.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit, canManageSharing, type ViewCtx } from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import { blockedUpstreamUrl, grantKeyHash } from '../../orchestrator/mcpProvider.js'
import { makeMcpPush } from '../mcp-push.js'
import { CONNECTOR_SERVICE_HEADER } from '../../connectors/index.js'
import {
  CreateMcpProviderBody,
  UpdateMcpProviderBody,
  McpProviderDto,
  McpProviderListDto,
  McpProviderCreatedDto,
  SetSharingBody,
  ErrorDto,
  IdParam,
  type McpProviderDtoT
} from '../dto/index.js'

/**
 * Grace-safe grant rotation (v1: one active grant per provider). Captures the prior
 * active grant(s) BEFORE minting (mintFor does not auto-revoke), pushes the NEW binding
 * + daemon proxy def into place via the SAME helper create/patch uses, then revokes and
 * rc/mcp-unassigns each OLD hash — so the new key is live before the old is torn down.
 * Returns the plaintext new grant key (echoed to the caller exactly once). Pure of
 * transport/DTO concerns; the route owns HTTP + RBAC. NEVER logs the key.
 *
 * Serialized per provider (via {@link serializeByProvider}) so it can't interleave with a
 * concurrent rotation/patch/delete — see that helper for why.
 */
export function rotateProviderGrant(
  provider: McpProviderRecord,
  headers: McpHeader[],
  orgId: OrgId,
  grants: McpGrantRepo,
  pushAssign: (p: McpProviderRecord, h: McpHeader[], grantKey: string, org: OrgId) => Promise<void>,
  unassignHash: (providerId: string, hash: string) => void
): Promise<string> {
  return serializeByProvider(orgId, provider.name, () =>
    rotateOnce(provider, headers, orgId, grants, pushAssign, unassignHash)
  )
}

/**
 * Serialize binding-mutating operations per provider. `rc/mcp-assign` ships the WHOLE
 * grant-hash allowlist (the relay replaces it), so any two ops that read the active grant
 * and push a binding can race: two rotations leave >1 active DB grant; a rotation racing a
 * PATCH/DELETE can republish the just-revoked key (or re-bind a torn-down provider), so the
 * relay ends up rejecting the key the caller was handed. Chaining every such op makes each
 * read-active→push a critical section, so the last push always reflects the current
 * active grant.
 *
 * Chains are keyed by (orgId, name) — the DURABLE binding key — not the provider row id:
 * agents store the NAME, so lifecycle events on different rows under the same name (drop
 * A, create B) must serialize with each other and with agent enable-list writes; an
 * id-keyed chain dies with its row and lets a same-name recreate slip into the window.
 * ponytail: in-process lock, sufficient because the CP is a single Fastify process; swap
 * to pg_advisory_xact_lock (see persistence/repositories/hook.repo.ts) if it goes
 * multi-instance.
 */
const providerChains = new Map<string, Promise<unknown>>()

const providerChainKey = (orgId: string, name: string) => `${orgId}\0${name}`

export function serializeByProvider<T>(orgId: string, name: string, run: () => Promise<T>): Promise<T> {
  const key = providerChainKey(orgId, name)
  const prev = providerChains.get(key) ?? Promise.resolve()
  const result = prev.then(run, run)
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  providerChains.set(key, settled)
  void settled.finally(() => {
    if (providerChains.get(key) === settled) providerChains.delete(key)
  })
  return result
}

/**
 * Serialize one operation across SEVERAL provider-name chains — how an agent
 * enable-list write (routes/agents.ts) joins the chain of every name its submitted
 * list contains, so it cannot interleave with a DELETE between that delete's
 * reference check and its row drop, nor with a same-name provider create. Names are
 * chained whether or not they currently resolve to a registry row (the name IS the
 * durable key; a daemon-local name today may be a provider name in the same
 * breath). Chains are entered in sorted order so two multi-name writers can't
 * deadlock waiting on each other's tails.
 */
export function serializeByProviderNames<T>(
  orgId: string,
  names: readonly string[],
  run: () => Promise<T>
): Promise<T> {
  const sorted = [...new Set(names)].sort()
  return sorted.reduceRight<() => Promise<T>>((inner, n) => () => serializeByProvider(orgId, n, inner), run)()
}

async function rotateOnce(
  provider: McpProviderRecord,
  headers: McpHeader[],
  orgId: OrgId,
  grants: McpGrantRepo,
  pushAssign: (p: McpProviderRecord, h: McpHeader[], grantKey: string, org: OrgId) => Promise<void>,
  unassignHash: (providerId: string, hash: string) => void
): Promise<string> {
  const prior = await grants.activeForProvider(provider.id) // before mint — both would read active otherwise
  const fresh = await grants.mintFor(provider.id)
  await pushAssign(provider, headers, fresh.key, orgId) // new binding + proxy def in place first
  for (const g of prior) {
    await grants.revoke(g.id)
    unassignHash(provider.id, grantKeyHash(g.key))
  }
  return fresh.key
}

function toDto(p: McpProviderRecord, ctx: ViewCtx, headers: McpHeader[]): McpProviderDtoT {
  // For open_connector providers the service slug rides as a non-secret binding
  // header — surface it so the console can render the provider's icon.
  const service =
    p.kind === 'open_connector' ? headers.find((h) => h.name === CONNECTOR_SERVICE_HEADER)?.value : undefined
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    transport: p.transport,
    url: p.url,
    ...(service ? { service } : {}),
    visibility: p.visibility,
    sharedWith: p.sharedWith,
    createdBy: p.createdByUserId,
    canEdit: canEdit(p, ctx),
    canManageSharing: canManageSharing(p, ctx),
    headerNames: headers.map((h) => h.name), // NEVER the values
    createdAt: p.createdAt.toISOString()
  }
}

export function mcpProviderRoutes(deps: HttpDeps) {
  return async function mcpProviderRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()

    // Shared relay+daemon push (also used by the connectors create flow).
    const { pushAssign, pushUnassign } = makeMcpPush(deps)

    r.get(
      '/mcp-providers',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'List MCP providers',
          description: 'Every MCP provider in the active organization (metadata + upstream header names only).',
          operationId: 'listMcpProviders',
          response: { 200: McpProviderListDto }
        }
      },
      async (req) => {
        const ctx = ctxOf(req)
        const rows = await deps.repos.mcpProvider.listForOrg(orgOf(req), ctx)
        return Promise.all(rows.map(async (p) => toDto(p, ctx, (await deps.repos.mcpProviderSecret.get(p.id)) ?? [])))
      }
    )

    r.get(
      '/mcp-providers/:id',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Get an MCP provider',
          description:
            "Fetch a single MCP provider by id (scoped to the caller's org; a cross-org id reads as 404). Header values and the grant key are never returned.",
          operationId: 'getMcpProvider',
          params: IdParam,
          response: { 200: McpProviderDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const p = await deps.repos.mcpProvider.get(req.params.id)
        // A cross-org id OR a restricted provider the caller can't see both read as 404.
        if (!p || p.orgId !== orgOf(req) || !canView(p, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        return toDto(p, ctxOf(req), (await deps.repos.mcpProviderSecret.get(p.id)) ?? [])
      }
    )

    r.post(
      '/mcp-providers',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Register an MCP provider',
          description:
            'Register an org-level upstream MCP server (http transport, org visibility) and mint its bearer grant key. The grant key is returned exactly once and is never retrievable afterward; upstream header values go in and never come back. Rejected with 409 while any agent already enables an MCP server under the requested name — agents bind by name, so a new provider must not silently capture existing selections.',
          operationId: 'createMcpProvider',
          body: CreateMcpProviderBody,
          response: { 201: McpProviderCreatedDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        // v1 policy: http transport only (P3 lifts this, §6).
        if (req.body.transport !== undefined && req.body.transport !== 'http') {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'only the http transport is supported' })
        }
        const blocked = blockedUpstreamUrl(req.body.url)
        if (blocked) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: blocked })
        }
        // sharedWith only bites when restricted; intersect with real org members.
        const sharedWith =
          req.body.visibility === 'restricted' && req.body.sharedWith
            ? await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
            : undefined
        // Name-capture guard — the mirror image of the delete guard, in the same
        // (orgId, name) chain: agents bind by NAME, so registering a provider under a
        // name agents already enable would capture their sessions onto this new
        // upstream without any per-agent consent. Refuse while referenced; the chain
        // makes check→create atomic against enable-list writes and a same-name delete.
        const created = await serializeByProvider(orgOf(req), req.body.name, async () => {
          const agents = await deps.repos.agent.list(orgOf(req))
          if (agents.some((a) => a.mcpServers.includes(req.body.name))) return null
          const provider = await deps.repos.mcpProvider.create({
            orgId: orgOf(req),
            name: req.body.name,
            url: req.body.url,
            ...(req.body.visibility ? { visibility: req.body.visibility } : {}),
            ...(sharedWith ? { sharedWith } : {}),
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          })
          await deps.repos.mcpProviderSecret.put(provider.id, req.body.headers)
          // Exactly one active grant per provider (v1). Plaintext returned once.
          const grant = await deps.repos.mcpGrant.mintFor(provider.id)
          await pushAssign(provider, req.body.headers, grant.key, orgOf(req))
          return { provider, grant }
        })
        if (!created) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message:
              'an agent already enables an MCP server with this name; unselect it there first or pick another name'
          })
        }
        return reply
          .code(201)
          .send({ ...toDto(created.provider, ctxOf(req), req.body.headers), grantKey: created.grant.key })
      }
    )

    r.patch(
      '/mcp-providers/:id',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Update an MCP provider',
          description:
            'Edit an MCP provider’s url and/or upstream headers. `headers` replaces the stored set wholesale; a changed url passes the SSRF gate. Name, transport, and visibility are immutable through this surface (agents bind by name; recreate to rename).',
          operationId: 'updateMcpProvider',
          params: IdParam,
          body: UpdateMcpProviderBody,
          response: { 200: McpProviderDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.mcpProvider.get(req.params.id)
        if (!existing || existing.orgId !== orgOf(req) || !canView(existing, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        // An open_connector row's url (the shared open-connector /mcp endpoint) and headers
        // (the x-oomol-connector-* binding markers) are CP-managed — editing them here would
        // sever the connection's binding. Refresh its credential via /connectors/.../reconnect
        // instead; this surface only touches custom providers' upstream url/headers.
        if (existing.kind === 'open_connector') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'open-connector connections cannot edit url or headers — reconnect instead'
          })
        }
        if (req.body.url !== undefined) {
          const blocked = blockedUpstreamUrl(req.body.url)
          if (blocked) return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: blocked })
        }
        // Name is immutable (see UpdateMcpProviderBody): agents bind by name and there's
        // no atomic rename, so only the url may change the row here.
        const provider =
          req.body.url !== undefined
            ? await deps.repos.mcpProvider.update(existing.id, { url: req.body.url })
            : existing
        if (req.body.headers !== undefined) await deps.repos.mcpProviderSecret.put(provider.id, req.body.headers)
        const headers = req.body.headers ?? (await deps.repos.mcpProviderSecret.get(provider.id)) ?? []
        // Re-push the binding + proxy def (name/url/headers may have changed). The grant key
        // is unchanged (patch never re-mints), so read the active one — but INSIDE the
        // per-provider lock, so a concurrent rotation can't leave us pushing its revoked key.
        await serializeByProvider(orgOf(req), provider.name, async () => {
          const grant = (await deps.repos.mcpGrant.activeForProvider(provider.id))[0]
          if (grant) await pushAssign(provider, headers, grant.key, orgOf(req))
        })
        return toDto(provider, ctxOf(req), headers)
      }
    )

    r.post(
      '/mcp-providers/:id/grant/rotate',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Rotate an MCP provider grant key',
          description:
            'Mint a fresh bearer grant key for the provider and retire the previous one. The new key + binding are pushed to relays and daemons before the old grant is revoked (grace-safe). Like create, the new grant key is returned exactly once and is never retrievable afterward.',
          operationId: 'rotateMcpProviderGrant',
          params: IdParam,
          response: { 200: McpProviderCreatedDto, 403: ErrorDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const provider = await deps.repos.mcpProvider.get(req.params.id)
        if (!provider || provider.orgId !== orgOf(req) || !canView(provider, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        const headers = (await deps.repos.mcpProviderSecret.get(provider.id)) ?? []
        const grantKey = await rotateProviderGrant(
          provider,
          headers,
          orgOf(req),
          deps.repos.mcpGrant,
          pushAssign,
          (providerId, grantKeyHash) => deps.relayControl.mcpUnassign({ providerId, grantKeyHash })
        )
        return reply.code(200).send({ ...toDto(provider, ctxOf(req), headers), grantKey })
      }
    )

    // Set who can see this provider (visibility + share set). Same gate as agents
    // (canManageSharing === canEdit): viewers can't, a collaborator who can't view a
    // restricted provider 404s. Visibility never rides the wire, so nothing to push.
    // The write joins the (orgId, name) chain: agent enable-list writes authorize
    // against provider visibility INSIDE that chain (routes/agents.ts), so a sharing
    // flip must not land between their check and their commit.
    r.put(
      '/mcp-providers/:id/sharing',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Set MCP provider sharing',
          description:
            'Set an MCP provider’s visibility (Everyone vs Selected) and complete Selected audience. Requires edit rights; Selected must retain at least one current organization member, and sharedWith is intersected with current membership.',
          operationId: 'setMcpProviderSharing',
          params: IdParam,
          body: SetSharingBody,
          response: { 200: McpProviderDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.mcpProvider.get(req.params.id)
        if (!existing || existing.orgId !== orgOf(req) || !canView(existing, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        if (!canManageSharing(existing, ctxOf(req))) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'cannot change sharing' })
        }
        const sharedWith = await resolveShareSet(deps.repos.user, orgOf(req), req.body.sharedWith)
        const provider = await serializeByProvider(orgOf(req), existing.name, () =>
          deps.repos.mcpProvider.setSharing(
            existing.id,
            {
              visibility: req.body.visibility,
              sharedWith
            },
            req.principal?.userId
          )
        )
        return toDto(provider, ctxOf(req), (await deps.repos.mcpProviderSecret.get(provider.id)) ?? [])
      }
    )

    r.delete(
      '/mcp-providers/:id',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Delete an MCP provider',
          description:
            'Delete an MCP provider, unbind it from relays/daemons, and cascade-drop its upstream secret and grants. Rejected with 409 while any agent still enables it — unselect it from those agents first.',
          operationId: 'deleteMcpProvider',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyViewerWrite(req, reply)) return
        const existing = await deps.repos.mcpProvider.get(req.params.id)
        if (!existing || existing.orgId !== orgOf(req) || !canView(existing, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'mcp provider not found' })
        }
        // Serialized with rotation/patch: unbind + delete must not interleave with a rotation
        // that would re-bind a torn-down provider (or mint against a cascade-deleted row).
        const outcome = await serializeByProvider(orgOf(req), existing.name, async () => {
          // Agents bind a provider by NAME (runtimeOverrides.mcpServers), so deleting while
          // referenced would leave dangling selectors that silently re-bind to any future
          // provider recreated under the same name. Same rule as skill-source delete. The
          // check lives INSIDE the (orgId, name) chain because agent enable-list writes and
          // same-name provider creates join it too (serializeByProviderNames in
          // routes/agents.ts, the create guard above): a concurrent enable cannot slip a
          // reference in between this read and the row drop — it either commits first (we
          // 409) or waits until the provider is gone (its name resolves as a daemon-local
          // server, and the create guard keeps the name uncapturable while referenced).
          const agents = await deps.repos.agent.list(orgOf(req))
          if (agents.some((a) => a.mcpServers.includes(existing.name))) return 'referenced' as const
          await pushUnassign(existing, orgOf(req)) // unbind relays + affected daemons (before the row is gone)
          await deps.repos.mcpProvider.delete(existing.id) // FK cascade drops secret + grants
          return 'deleted' as const
        })
        if (outcome === 'referenced') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'mcp provider is still enabled by one or more agents; unselect it there first'
          })
        }
        return reply.code(204).send(null)
      }
    )
  }
}

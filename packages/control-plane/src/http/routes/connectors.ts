/**
 * `http/routes/connectors.ts` (docs: connectors integration) — the CP-brokered
 * open-connector surface. The console never talks to open-connector directly; every
 * call goes through here so the open-connector URL + admin API stay server-side.
 *
 * Enablement is `deps.connectors` (assembled only when OPEN_CONNECTOR_URL is set) —
 * absent ⇒ every route 404s and the console hides the "Add connectors" menu item.
 *
 * Creating a connection does two things atomically-ish: (1) record it as an
 * `open_connector` MCP provider named `connectionName` (org-unique via
 * @@unique([orgId,name]) ⇒ 409 on dup; mints a grant + pushes the relay binding like
 * any provider), and (2) provision the connection PROFILE in open-connector
 * (`<org>--<user>--<name>`). If step 2's api-key save fails, step 1 is rolled back.
 * NOTE: this phase records the provider row; open-connector's /mcp does not yet honor
 * the profile alias (deferred), so runtime tool calls resolve its default connection.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, denyViewerWrite, ctxOf } from '../rbac.js'
import { canView, canEdit, canManageSharing } from '../../authorization/policy.js'
import { resolveShareSet } from '../sharing.js'
import { makeMcpPush } from '../mcp-push.js'
import { serializeByProvider } from './mcp-providers.js'
import { composeProfileName, CONNECTOR_ALIAS_HEADER, CONNECTOR_SERVICE_HEADER } from '../../connectors/index.js'
import { ConnectorsError } from '../../connectors/client.js'
import {
  ConnectorsConfigDto,
  ConnectorCatalogDto,
  CreateConnectorConnectionBody,
  ConnectorConnectionCreatedDto,
  ReconnectConnectorConnectionBody,
  ReconnectConnectorConnectionDto,
  IdParam,
  ErrorDto
} from '../dto/index.js'

const notFound = { error: 'Not Found', statusCode: 404, message: 'connectors not configured' } as const

export function connectorRoutes(deps: HttpDeps) {
  return async function connectorRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const { pushAssign, pushUnassign } = makeMcpPush(deps)

    r.get(
      '/connectors/config',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Connectors feature status',
          description: 'Whether the open-connector integration is configured on this CP (drives the Add menu).',
          operationId: 'getConnectorsConfig',
          response: { 200: ConnectorsConfigDto }
        }
      },
      async () => ({ enabled: deps.connectors != null })
    )

    r.get(
      '/connectors/catalog',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Browse connector providers',
          description:
            'The open-connector provider catalog, filtered to connectable providers (non-OAuth, or OAuth with a configured client secret), the provider whitelist, and the provider blocklist. 404 when the integration is not configured.',
          operationId: 'listConnectorProviders',
          response: { 200: ConnectorCatalogDto, 404: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.connectors) return reply.code(404).send(notFound)
        try {
          return await deps.connectors.catalog()
        } catch {
          return reply.code(502).send({ error: 'Bad Gateway', statusCode: 502, message: 'open-connector unavailable' })
        }
      }
    )

    r.post(
      '/connectors/connections',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Create a connector connection',
          description:
            'Provision a new open-connector connection and record it as an open_connector MCP provider (named connectionName, org-unique). For api-key/custom/no-auth the credentials are saved immediately; for oauth2 an authorizationUrl is returned to open in a popup. The grant key is returned exactly once.',
          operationId: 'createConnectorConnection',
          body: CreateConnectorConnectionBody,
          response: {
            201: ConnectorConnectionCreatedDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            502: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (!deps.connectors) return reply.code(404).send(notFound)
        if (denyViewerWrite(req, reply)) return
        const userId = req.principal?.userId
        if (!userId) {
          return reply.code(403).send({ error: 'Forbidden', statusCode: 403, message: 'no user principal' })
        }
        const orgId = orgOf(req)
        const { service, connectionName, authType, values } = req.body
        // sharedWith only bites when restricted; intersect with real org members.
        const sharedWith =
          req.body.visibility === 'restricted' && req.body.sharedWith
            ? await resolveShareSet(deps.repos.user, orgId, req.body.sharedWith)
            : undefined
        const profile = composeProfileName(orgId, userId, connectionName)
        // Both markers ride to the relay as binding headers: the profile (which
        // connection) and the service (which actions to expose). Neither is secret.
        const headers = [
          { name: CONNECTOR_ALIAS_HEADER, value: profile },
          { name: CONNECTOR_SERVICE_HEADER, value: service }
        ]

        // 1) Record the connection as an open_connector MCP provider. The org-unique
        //    name is the atomic reservation — a duplicate throws P2002 ⇒ 409. Created
        //    inside the (orgId, name) chain with the same name-capture guard as
        //    POST /mcp-providers: agents bind by NAME, so a connection under a name
        //    agents already enable would capture their sessions onto this upstream.
        let provider
        try {
          provider = await serializeByProvider(orgId, connectionName, async () => {
            const agents = await deps.repos.agent.list(orgId)
            if (agents.some((a) => a.mcpServers.includes(connectionName))) return null
            return deps.repos.mcpProvider.create({
              orgId,
              name: connectionName,
              url: deps.connectors!.mcpUrl,
              kind: 'open_connector',
              createdByUserId: userId,
              ...(req.body.visibility ? { visibility: req.body.visibility } : {}),
              ...(sharedWith ? { sharedWith } : {})
            })
          })
        } catch (e) {
          if ((e as { code?: string }).code === 'P2002') {
            return reply
              .code(409)
              .send({ error: 'Conflict', statusCode: 409, message: `connection "${connectionName}" already exists` })
          }
          throw e
        }
        if (!provider) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message:
              'an agent already enables an MCP server with this name; unselect it there first or pick another name'
          })
        }
        // 2) Store markers, mint the grant, push the binding, and provision the profile
        //    in open-connector. Any failure here rolls the whole thing back so a partial
        //    step never strands an orphan provider row / binding.
        try {
          await deps.repos.mcpProviderSecret.put(provider.id, headers)
          const grant = await deps.repos.mcpGrant.mintFor(provider.id)
          await pushAssign(provider, headers, grant.key, orgId)

          const dto = {
            id: provider.id,
            name: provider.name,
            kind: provider.kind,
            transport: provider.transport,
            url: provider.url,
            service,
            visibility: provider.visibility,
            sharedWith: provider.sharedWith,
            createdBy: provider.createdByUserId,
            canEdit: canEdit(provider, ctxOf(req)),
            canManageSharing: canManageSharing(provider, ctxOf(req)),
            headerNames: headers.map((h) => h.name),
            createdAt: provider.createdAt.toISOString(),
            grantKey: grant.key
          }
          if (authType === 'oauth2') {
            const { authorizationUrl } = await deps.connectors.startOAuth(service, profile)
            return reply.code(201).send({ ...dto, ...(authorizationUrl ? { authorizationUrl } : {}) })
          }
          await deps.connectors.saveConnection(service, {
            authType,
            connectionName: profile,
            ...(values ? { values } : {})
          })
          return reply.code(201).send(dto)
        } catch (e) {
          // Roll back the just-created provider row (+ its binding/secret/grant via
          // cascade) so a failed step never strands an unusable connection. Serialized
          // with rotation/patch/delete — and REFERENCE-SAFE like the DELETE route: the
          // row was committed (visible) before the upstream step, so an agent write may
          // have enabled this name in the meantime (it serialized on this same chain).
          // Deleting then would leave the dangling selector the delete guard exists to
          // prevent, so a referenced row is kept instead: the caller still gets the
          // error below, and reconnect repairs the connection (or delete it after
          // unselecting).
          await serializeByProvider(orgId, provider.name, async () => {
            const agents = await deps.repos.agent.list(orgId)
            if (agents.some((a) => a.mcpServers.includes(provider.name))) return
            await pushUnassign(provider, orgId)
            await deps.repos.mcpProvider.delete(orgId, provider.id)
          })
          // A 4xx upstream is the caller's fault (bad creds) → 400; anything else → 502.
          // Keep the body's statusCode consistent with the HTTP status actually sent.
          const upstream = e instanceof ConnectorsError ? e.status : 502
          const code = upstream >= 400 && upstream < 500 ? 400 : 502
          return reply.code(code).send({
            error: code === 400 ? 'Bad Request' : 'Bad Gateway',
            statusCode: code,
            message: e instanceof Error ? e.message : 'open-connector save failed'
          })
        }
      }
    )

    r.post(
      '/connectors/connections/:id/reconnect',
      {
        schema: {
          tags: [Tag.Mcp],
          summary: 'Reconnect a connector connection',
          description:
            'Re-run authorization (oauth2) or re-save credentials (api-key/custom) for an existing open_connector connection — for when its upstream token expired/was revoked or the api key rotated. The provider row, grant key, and relay binding are untouched; the service + connection profile are re-derived from the stored binding markers. For oauth2 an authorizationUrl is returned to open in a popup.',
          operationId: 'reconnectConnectorConnection',
          params: IdParam,
          body: ReconnectConnectorConnectionBody,
          response: { 200: ReconnectConnectorConnectionDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.connectors) return reply.code(404).send(notFound)
        if (denyViewerWrite(req, reply)) return
        const provider = await deps.repos.mcpProvider.get(orgOf(req), req.params.id)
        // A cross-org id (fenced in the repo) OR a restricted provider the caller
        // can't see both read as 404.
        if (!provider || !canView(provider, ctxOf(req))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        if (provider.kind !== 'open_connector') {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: 'not a connector connection' })
        }
        // Re-derive the service + connection profile from the stored binding markers
        // (the alias carries the creator's userId, so recompute would drift for a
        // non-creator caller — always read it back from the row).
        const headers = (await deps.repos.mcpProviderSecret.get(provider.id)) ?? []
        const service = headers.find((h) => h.name === CONNECTOR_SERVICE_HEADER)?.value
        const profile = headers.find((h) => h.name === CONNECTOR_ALIAS_HEADER)?.value
        if (!service || !profile) {
          return reply
            .code(400)
            .send({ error: 'Bad Request', statusCode: 400, message: 'connection is missing its binding markers' })
        }
        const { authType, values } = req.body
        try {
          if (authType === 'oauth2') {
            const { authorizationUrl } = await deps.connectors.startOAuth(service, profile)
            return reply.code(200).send({ ...(authorizationUrl ? { authorizationUrl } : {}) })
          }
          await deps.connectors.saveConnection(service, {
            authType,
            connectionName: profile,
            ...(values ? { values } : {})
          })
          return reply.code(200).send({})
        } catch (e) {
          // A 4xx upstream is the caller's fault (bad creds) → 400; anything else → 502.
          const upstream = e instanceof ConnectorsError ? e.status : 502
          const code = upstream >= 400 && upstream < 500 ? 400 : 502
          return reply.code(code).send({
            error: code === 400 ? 'Bad Request' : 'Bad Gateway',
            statusCode: code,
            message: e instanceof Error ? e.message : 'open-connector reconnect failed'
          })
        }
      }
    )
  }
}

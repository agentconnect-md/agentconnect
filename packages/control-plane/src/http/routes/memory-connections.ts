/**
 * M-5A owner-reviewed plugin installations and org external-memory connections.
 * Secret values are write-only; daemon grants are internal and never appear in
 * HTTP responses. Relay/daemon pushes are best-effort with reconnect snapshots
 * as the convergence backstop.
 */
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MemoryConnectionSpec } from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import type { ExternalMemoryConnectionRecord, MemoryPluginInstallationRecord } from '../../persistence/ports.js'
import type { OrgId } from '../../domain/ids.js'
import { denyNonOwner, orgOf } from '../rbac.js'
import { Tag } from '../plugins/openapi.js'
import { blockedUpstreamUrl, relayHttpOrigin } from '../../orchestrator/mcpProvider.js'
import {
  boundedMemoryConfig,
  memoryConnectionSpec,
  memoryRcAssign,
  stdioMemoryConnectionSpec,
  validateMemorySecretHeaders,
  validateMemorySecrets
} from '../../orchestrator/memoryConnection.js'
import {
  CreateMemoryPluginInstallationBody,
  MemoryPluginInstallationDto,
  MemoryPluginInstallationListDto,
  CreateExternalMemoryConnectionBody,
  UpdateExternalMemoryConnectionBody,
  ExternalMemoryConnectionDto,
  ExternalMemoryConnectionListDto,
  ErrorDto,
  IdParam,
  type MemoryPluginInstallationDtoT,
  type ExternalMemoryConnectionDtoT
} from '../dto/index.js'

function installationDto(row: MemoryPluginInstallationRecord): MemoryPluginInstallationDtoT {
  return {
    id: row.id,
    pluginId: row.pluginId,
    transport: row.transport,
    endpoint: row.endpoint,
    commandRef: row.commandRef,
    pinnedProfileMajor: 1,
    expectedManifestDigest: row.expectedManifestDigest,
    secretHeaders: row.secretHeaders,
    createdBy: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

async function connectionDto(
  row: ExternalMemoryConnectionRecord,
  deps: HttpDeps
): Promise<ExternalMemoryConnectionDtoT> {
  return {
    id: row.id,
    installationId: row.installationId,
    config: row.config,
    secretKeys: await deps.repos.externalMemoryConnectionSecret.keys(row.orgId, row.id),
    status: row.status,
    revision: row.revision,
    probedRevision: row.probedRevision,
    pluginVersion: row.pluginVersion,
    profile: row.profile,
    manifestDigest: row.manifestDigest,
    capabilities: row.capabilities,
    declaredEgressHosts: row.declaredEgressHosts,
    reasonCode: row.reasonCode,
    createdBy: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

export function memoryConnectionRoutes(deps: HttpDeps) {
  return async function memoryConnectionRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const relayBaseUrl = async (): Promise<string | null> => {
      const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 0)))
      return alive[0]?.daemonUrl ? relayHttpOrigin(alive[0].daemonUrl) : null
    }

    const agentsUsing = async (orgId: OrgId, connectionId: string) =>
      (await deps.repos.agent.list(orgId)).filter(
        (agent) => agent.memory?.provider === 'external' && agent.memory.connectionId === connectionId
      )

    /** Push the full relay allowlist, then one chosen grant to every daemon SERVING
     * a using agent — its placement plus any duty holder, resolved through
     * AgentDelivery. Returns true only when every such consumer acknowledged the
     * chosen definition. Durable CRUD ignores a false result and converges on
     * reconnect; grant retirement uses it as a hard overlap-before-revoke fence, so
     * including holders is what stops a key being retired under a holder still on it. */
    const pushConnection = async (
      connection: ExternalMemoryConnectionRecord,
      installation: MemoryPluginInstallationRecord,
      secrets: Record<string, string>,
      daemonGrantKey?: string
    ): Promise<boolean> => {
      try {
        const daemonIds = new Set(
          await deps.agentDelivery.daemonsForAgents(await agentsUsing(connection.orgId, connection.id))
        )
        let spec: MemoryConnectionSpec
        if (installation.transport === 'stdio') {
          if (daemonIds.size === 0) return true
          spec = stdioMemoryConnectionSpec(connection, installation, secrets)
        } else {
          const grants = await deps.repos.externalMemoryGrant.activeForConnection(connection.orgId, connection.id)
          if (grants.length === 0) return false
          deps.relayControl.memoryConnectionAssign(
            memoryRcAssign(
              connection,
              installation,
              secrets,
              grants.map((grant) => grant.key)
            )
          )
          if (daemonIds.size === 0) return true
          const base = await relayBaseUrl()
          if (!base) return false
          const grantKey = daemonGrantKey ?? grants.at(-1)!.key
          spec = memoryConnectionSpec(connection, installation, Object.keys(secrets).sort(), grantKey, base)
        }
        const synced = await Promise.all(
          [...daemonIds].map(async (daemonId) => {
            try {
              await deps.control.memoryConnectionUpsert(daemonId, spec)
              return true
            } catch {
              return false
            }
          })
        )
        return synced.every(Boolean)
      } catch {
        // No error object: a provider/cipher failure can contain secret-bearing
        // detail. The opaque connection id is enough for operational correlation.
        app.log.warn({ connectionId: connection.id }, 'memory connection live projection deferred')
        return false
      }
    }

    r.get(
      '/memory-plugin-installations',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'List memory plugin installations',
          description: 'List owner-reviewed external-memory plugin installations for the active organization.',
          operationId: 'listMemoryPluginInstallations',
          response: { 200: MemoryPluginInstallationListDto }
        }
      },
      async (req) => (await deps.repos.memoryPluginInstallation.listForOrg(orgOf(req))).map(installationDto)
    )

    r.post(
      '/memory-plugin-installations',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Register a memory plugin installation',
          description:
            'Owner-only trust action. Register a pinned remote endpoint or an operator-installed local command reference and its reviewed logical-secret contract.',
          operationId: 'createMemoryPluginInstallation',
          body: CreateMemoryPluginInstallationBody,
          response: { 201: MemoryPluginInstallationDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (req.body.transport === 'streamable-http') {
          const blocked = blockedUpstreamUrl(req.body.endpoint!)
          if (blocked) return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: blocked })
        }
        const headerError = validateMemorySecretHeaders(req.body.secretHeaders)
        if (headerError) {
          return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: headerError })
        }
        const row = await deps.repos.memoryPluginInstallation.create({
          orgId: orgOf(req),
          pluginId: req.body.pluginId,
          transport: req.body.transport,
          ...(req.body.endpoint ? { endpoint: req.body.endpoint } : {}),
          ...(req.body.commandRef ? { commandRef: req.body.commandRef } : {}),
          pinnedProfileMajor: 1,
          ...(req.body.expectedManifestDigest ? { expectedManifestDigest: req.body.expectedManifestDigest } : {}),
          secretHeaders: req.body.secretHeaders,
          ...(req.principal ? { createdByUserId: req.principal.userId } : {})
        })
        return reply.code(201).send(installationDto(row))
      }
    )

    r.delete(
      '/memory-plugin-installations/:id',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Delete a memory plugin installation',
          description: 'Owner-only. Refused while an external-memory connection still references the installation.',
          operationId: 'deleteMemoryPluginInstallation',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        // Reference scan + row drop in one transaction under the installation's
        // advisory mutation scope — a concurrent connection create either
        // committed (⇒ 'referenced') or re-checks after the drop and 404s.
        const outcome = await deps.repos.memoryConnectionWriter.deleteInstallation(req.params.id, orgOf(req))
        if (outcome === 'busy') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'installation is being updated' })
        }
        if (outcome === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        if (outcome === 'referenced') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'installation still has external-memory connections'
          })
        }
        return reply.code(204).send(null)
      }
    )

    r.get(
      '/external-memory-connections',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'List external-memory connections',
          description:
            'List org connection metadata and secret field names. Secret values and daemon grants never return.',
          operationId: 'listExternalMemoryConnections',
          response: { 200: ExternalMemoryConnectionListDto }
        }
      },
      async (req) =>
        Promise.all(
          (await deps.repos.externalMemoryConnection.listForOrg(orgOf(req))).map((row) => connectionDto(row, deps))
        )
    )

    r.get(
      '/external-memory-connections/:id',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Get an external-memory connection',
          description: 'Get one org connection, its non-secret config, secret field names, and latest probe status.',
          operationId: 'getExternalMemoryConnection',
          params: IdParam,
          response: { 200: ExternalMemoryConnectionDto, 404: ErrorDto }
        }
      },
      async (req, reply) => {
        const row = await deps.repos.externalMemoryConnection.get(orgOf(req), req.params.id)
        if (!row) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        return connectionDto(row, deps)
      }
    )

    r.post(
      '/external-memory-connections',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Create an external-memory connection',
          description:
            'Owner-only. Store bounded non-secret config and write-only secret values, mint an internal relay grant, and begin daemon conformance probing.',
          operationId: 'createExternalMemoryConnection',
          body: CreateExternalMemoryConnectionBody,
          response: { 201: ExternalMemoryConnectionDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        // Friendly reads/validation first; the writer re-checks the installation
        // inside its transaction under the installation's advisory mutation
        // scope, and commits the row + sealed secrets + minted grant atomically
        // (no delete-the-row compensation pair anymore).
        const installation = await deps.repos.memoryPluginInstallation.get(req.body.installationId)
        if (!installation || installation.orgId !== orgOf(req)) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        const configError = boundedMemoryConfig(req.body.config)
        const secretError = validateMemorySecrets(installation.secretHeaders, req.body.secrets)
        if (configError || secretError) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: configError ?? secretError!
          })
        }
        const created = await deps.repos.memoryConnectionWriter.createConnection(
          {
            id: randomUUID(),
            orgId: orgOf(req),
            installationId: installation.id,
            config: req.body.config,
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          },
          req.body.secrets,
          installation.transport === 'streamable-http'
        )
        if (created.outcome === 'busy') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'installation is being updated' })
        }
        if (created.outcome === 'installation_missing') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        await pushConnection(created.connection, installation, req.body.secrets, created.grantKey)
        return reply.code(201).send(await connectionDto(created.connection, deps))
      }
    )

    r.patch(
      '/external-memory-connections/:id',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Update an external-memory connection',
          description:
            'Owner-only. Replace non-secret config and/or the complete write-only secret set, increment the connection revision, and re-run daemon probing.',
          operationId: 'updateExternalMemoryConnection',
          params: IdParam,
          body: UpdateExternalMemoryConnectionBody,
          response: { 200: ExternalMemoryConnectionDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const existing = await deps.repos.externalMemoryConnection.get(orgOf(req), req.params.id)
        if (!existing) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        const installation = await deps.repos.memoryPluginInstallation.get(existing.installationId)
        if (!installation) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        const priorSecrets = (await deps.repos.externalMemoryConnectionSecret.get(existing.orgId, existing.id)) ?? {}
        const secrets = req.body.secrets ?? priorSecrets
        const config = req.body.config ?? existing.config
        const configError = boundedMemoryConfig(config)
        const secretError = validateMemorySecrets(installation.secretHeaders, secrets)
        if (configError || secretError) {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: configError ?? secretError!
          })
        }
        // Secret replacement + revision bump commit as ONE transaction under
        // the connection's advisory mutation scope (the writer), so a failure
        // can't leave new secrets beside the old definition and no concurrent
        // mutation can interleave with the pair.
        const result = await deps.repos.memoryConnectionWriter.updateConnection(existing.id, orgOf(req), {
          ...(req.body.config !== undefined ? { config: req.body.config } : {}),
          ...(req.body.secrets !== undefined ? { secrets: req.body.secrets } : {})
        })
        if (result.outcome === 'busy') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        if (result.outcome === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        // Push the writer's in-transaction snapshot, never the pre-transaction
        // read above (which is validation input only): a config-only patch that
        // read old secrets, then committed AFTER a concurrent secret
        // replacement, would otherwise publish the old credential under the
        // newer revision — and the relay's revision gate would pin it there
        // until reconnect.
        await pushConnection(result.connection, installation, result.secrets)
        return connectionDto(result.connection, deps)
      }
    )

    r.post(
      '/external-memory-connections/:id/grant/rotate',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Rotate an external-memory relay grant',
          description:
            'Owner-only. Mint and distribute a new daemon-private grant before revoking the old grant. No grant value is returned.',
          operationId: 'rotateExternalMemoryConnectionGrant',
          params: IdParam,
          response: {
            200: ExternalMemoryConnectionDto,
            400: ErrorDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const connection = await deps.repos.externalMemoryConnection.get(orgOf(req), req.params.id)
        if (!connection) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        const installation = await deps.repos.memoryPluginInstallation.get(connection.installationId)
        if (!installation) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
        }
        if (installation.transport === 'stdio') {
          return reply.code(400).send({
            error: 'Bad Request',
            statusCode: 400,
            message: 'local stdio connections have no relay grant; replace the connection secrets instead'
          })
        }
        // Durable first half in one transaction under the connection's advisory
        // mutation scope: revision bump + fresh-grant mint (or newest reuse
        // after a failed earlier attempt — never an unbounded chain of pending
        // grants), with the active set CAS-checked against this read and the
        // secret snapshot paired with the committed revision.
        const prepared = await deps.repos.memoryConnectionWriter.prepareGrantRotation(connection.id, orgOf(req))
        if (prepared.outcome === 'busy') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        if (prepared.outcome === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        const distributed = await pushConnection(
          prepared.connection,
          installation,
          prepared.secrets,
          prepared.fresh.key
        )
        if (!distributed) {
          return reply.code(503).send({
            error: 'Service Unavailable',
            statusCode: 503,
            message: 'replacement grant was retained, but not every placed daemon acknowledged it; retry rotation'
          })
        }
        if (prepared.retiring.length === 0) return connectionDto(prepared.connection, deps)
        // Durable second half: revoke + revision bump in one fenced transaction,
        // then republish the post-retirement allowlist under that strictly newer
        // revision. The relay's whole-list assign replaces the hash set, so this
        // is what actually evicts the retired hash — a per-hash unassign only
        // applies at the exact current table revision, and a concurrent
        // mutation's assign landing between the overlap push and retirement
        // would make it a no-op, leaving the revoked grant authorized until
        // reconnect. The republish is best-effort like every projection push:
        // if it is lost, the reconnect baseline replays the post-revoke truth.
        const finalized = await deps.repos.memoryConnectionWriter.finalizeGrantRotation(
          connection.id,
          orgOf(req),
          prepared.retiring.map((grant) => grant.id)
        )
        if (finalized.outcome === 'busy') {
          // The overlap set (old + new, both acked) stays live; the operator
          // retries and the next rotation reuses the newest grant and retires
          // the remainder — the same convergence path as a failed overlap push.
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        if (finalized.outcome === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        await pushConnection(finalized.connection, installation, finalized.secrets, prepared.fresh.key)
        return connectionDto(finalized.connection, deps)
      }
    )

    r.delete(
      '/external-memory-connections/:id',
      {
        schema: {
          tags: [Tag.Memory],
          summary: 'Delete an external-memory connection',
          description:
            'Owner-only. Refused while an agent is bound; otherwise revokes relay/daemon state and deletes secrets and grants.',
          operationId: 'deleteExternalMemoryConnection',
          params: IdParam,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        const connection = await deps.repos.externalMemoryConnection.get(orgOf(req), req.params.id)
        if (!connection) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        const installation = await deps.repos.memoryPluginInstallation.get(connection.installationId)
        // Binding scan + row drop in one transaction under the connection's
        // advisory mutation scope — agent binds take the same scope inside
        // their own transactions, so a bind either committed (⇒ 'bound') or
        // re-verifies the connection after this drop and is refused.
        const deleted = await deps.repos.memoryConnectionWriter.deleteConnection(connection.id, orgOf(req))
        if (deleted.outcome === 'busy') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        if (deleted.outcome === 'not_found') {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
        }
        if (deleted.outcome === 'bound') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'connection is still bound to an agent'
          })
        }
        if (installation?.transport === 'streamable-http') {
          // The tombstone revision comes from the fenced delete transaction —
          // the `connection` read at route entry can be stale (a completed
          // rotation advances TWO revisions), and the relay drops a tombstone at
          // or below the revision it already holds, which would leave the
          // deleted upstream and grant hashes live until reconnect.
          deps.relayControl.memoryConnectionUnassign({
            connectionId: connection.id,
            revision: deleted.tombstoneRevision
          })
        }
        return reply.code(204).send(null)
      }
    )
  }
}

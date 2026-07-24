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
import { blockedUpstreamUrl, grantKeyHash, relayHttpOrigin } from '../../orchestrator/mcpProvider.js'
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
    secretKeys: await deps.repos.externalMemoryConnectionSecret.keys(row.id),
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
    const installationMutationId = (id: string) => `installation:${id}`
    const relayBaseUrl = async (): Promise<string | null> => {
      const alive = await deps.repos.relay.listAlive(new Date(Date.now() - (deps.config.RELAY_STALE_MS ?? 0)))
      return alive[0]?.daemonUrl ? relayHttpOrigin(alive[0].daemonUrl) : null
    }

    const agentsUsing = async (orgId: OrgId, connectionId: string) =>
      (await deps.repos.agent.list(orgId)).filter(
        (agent) => agent.memory?.provider === 'external' && agent.memory.connectionId === connectionId
      )

    /** Push the full relay allowlist, then one chosen grant to every using daemon.
     * Returns true only when every currently placed consumer acknowledged the
     * chosen definition. Durable CRUD ignores a false result and converges on
     * reconnect; grant retirement uses it as a hard overlap-before-revoke fence. */
    const pushConnection = async (
      connection: ExternalMemoryConnectionRecord,
      installation: MemoryPluginInstallationRecord,
      secrets: Record<string, string>,
      daemonGrantKey?: string
    ): Promise<boolean> => {
      try {
        const daemonIds = new Set(
          (await agentsUsing(connection.orgId, connection.id)).flatMap((a) => (a.daemonId ? [a.daemonId] : []))
        )
        let spec: MemoryConnectionSpec
        if (installation.transport === 'stdio') {
          if (daemonIds.size === 0) return true
          spec = stdioMemoryConnectionSpec(connection, installation, secrets)
        } else {
          const grants = await deps.repos.externalMemoryGrant.activeForConnection(connection.id)
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
        const release = deps.memoryConnectionMutations.tryBeginMutation(installationMutationId(req.params.id))
        if (!release) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'installation is being updated' })
        }
        try {
          const installation = await deps.repos.memoryPluginInstallation.get(req.params.id)
          if (!installation || installation.orgId !== orgOf(req)) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
          }
          if (
            (await deps.repos.externalMemoryConnection.listForOrg(orgOf(req))).some(
              (c) => c.installationId === installation.id
            )
          ) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'installation still has external-memory connections'
            })
          }
          await deps.repos.memoryPluginInstallation.delete(installation.id)
          return reply.code(204).send(null)
        } finally {
          release()
        }
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
        const row = await deps.repos.externalMemoryConnection.get(req.params.id)
        if (!row || row.orgId !== orgOf(req)) {
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
        const connectionId = randomUUID()
        const release = deps.memoryConnectionMutations.tryBeginMutation([
          installationMutationId(req.body.installationId),
          connectionId
        ])
        if (!release) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'installation is being updated' })
        }
        try {
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
          const row = await deps.repos.externalMemoryConnection.create({
            id: connectionId,
            orgId: orgOf(req),
            installationId: installation.id,
            config: req.body.config,
            ...(req.principal ? { createdByUserId: req.principal.userId } : {})
          })
          try {
            await deps.repos.externalMemoryConnectionSecret.put(row.id, req.body.secrets)
            const grant =
              installation.transport === 'streamable-http'
                ? await deps.repos.externalMemoryGrant.mintFor(row.id)
                : undefined
            await pushConnection(row, installation, req.body.secrets, grant?.key)
          } catch (error) {
            await deps.repos.externalMemoryConnection.delete(row.id).catch(() => undefined)
            throw error
          }
          return reply.code(201).send(await connectionDto(row, deps))
        } finally {
          release()
        }
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
        const release = deps.memoryConnectionMutations.tryBeginMutation(req.params.id)
        if (!release) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        try {
          const existing = await deps.repos.externalMemoryConnection.get(req.params.id)
          if (!existing || existing.orgId !== orgOf(req)) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
          }
          const installation = await deps.repos.memoryPluginInstallation.get(existing.installationId)
          if (!installation) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'installation not found' })
          }
          const priorSecrets = (await deps.repos.externalMemoryConnectionSecret.get(existing.id)) ?? {}
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
          if (req.body.secrets !== undefined) {
            await deps.repos.externalMemoryConnectionSecret.put(existing.id, req.body.secrets)
          }
          let updated: ExternalMemoryConnectionRecord
          try {
            updated = await deps.repos.externalMemoryConnection.update(existing.id, {
              ...(req.body.config !== undefined ? { config: req.body.config } : {})
            })
          } catch (error) {
            if (req.body.secrets !== undefined) {
              await deps.repos.externalMemoryConnectionSecret.put(existing.id, priorSecrets).catch(() => undefined)
            }
            throw error
          }
          await pushConnection(updated, installation, secrets)
          return connectionDto(updated, deps)
        } finally {
          release()
        }
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
        const release = deps.memoryConnectionMutations.tryBeginMutation(req.params.id)
        if (!release) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        try {
          const connection = await deps.repos.externalMemoryConnection.get(req.params.id)
          if (!connection || connection.orgId !== orgOf(req)) {
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
          const prior = await deps.repos.externalMemoryGrant.activeForConnection(connection.id)
          const updated = await deps.repos.externalMemoryConnection.update(connection.id, {})
          // A failed earlier attempt leaves old+new active. Reuse the newest key
          // on retry instead of minting an unbounded chain of pending grants.
          const fresh = prior.length > 1 ? prior.at(-1)! : await deps.repos.externalMemoryGrant.mintFor(connection.id)
          const retiring = prior.filter((grant) => grant.id !== fresh.id)
          const secrets = (await deps.repos.externalMemoryConnectionSecret.get(connection.id)) ?? {}
          const distributed = await pushConnection(updated, installation, secrets, fresh.key)
          if (!distributed) {
            return reply.code(503).send({
              error: 'Service Unavailable',
              statusCode: 503,
              message: 'replacement grant was retained, but not every placed daemon acknowledged it; retry rotation'
            })
          }
          for (const grant of retiring) {
            await deps.repos.externalMemoryGrant.revoke(grant.id)
            deps.relayControl.memoryConnectionUnassign({
              connectionId: connection.id,
              revision: updated.revision,
              grantKeyHash: grantKeyHash(grant.key)
            })
          }
          return connectionDto(updated, deps)
        } finally {
          release()
        }
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
        const release = deps.memoryConnectionMutations.tryBeginMutation(req.params.id)
        if (!release) {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'connection is being updated' })
        }
        try {
          const connection = await deps.repos.externalMemoryConnection.get(req.params.id)
          if (!connection || connection.orgId !== orgOf(req)) {
            return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'connection not found' })
          }
          const users = await agentsUsing(connection.orgId, connection.id)
          if (users.length) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'connection is still bound to an agent'
            })
          }
          const installation = await deps.repos.memoryPluginInstallation.get(connection.installationId)
          await deps.repos.externalMemoryConnection.delete(connection.id)
          if (installation?.transport === 'streamable-http') {
            deps.relayControl.memoryConnectionUnassign({
              connectionId: connection.id,
              revision: connection.revision + 1
            })
          }
          return reply.code(204).send(null)
        } finally {
          release()
        }
      }
    )
  }
}

/**
 * Managed cluster execution (docs/designs/agentconnect-org-operator.md).
 *
 *   GET  /orgs/:orgId/cluster-execution            — the org's envelope settings
 *   PUT  /orgs/:orgId/cluster-execution            — owner-only; write + reconcile
 *   POST /orgs/:orgId/cluster-execution/ensure     — owner-only; idempotent provision
 *   POST /orgs/:orgId/cluster-execution/credential — owner-only; issue / rotate
 *   GET  /orgs/:orgId/cluster-execution/status     — live status from the resource
 *
 * The settings row is desired state; the resource is the truth. So the write
 * path persists first and then applies, and the status path never reads the
 * database for anything the operator owns. The credential path is the key
 * authority: it publishes the key into the cluster Secret and never returns it.
 * Absent cluster configuration ⇒ the plugin registers nothing and the whole
 * surface 404s.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { Tag } from '../plugins/openapi.js'
import { denyNonOwner, orgOf } from '../rbac.js'
import { sendClusterFailure } from '../cluster-failure.js'
import {
  ClusterNotEnabledError,
  ClusterRotationInProgressError,
  NamespaceNotReadyError,
  type ClusterExecutionService
} from '../../cluster/index.js'
import type { ClusterExecutionSettings } from '../../persistence/ports.js'
import {
  ClusterCredentialDto,
  ClusterEnsureResultDto,
  ClusterEnvelopeStatusDto,
  ClusterExecutionSettingsDto,
  ErrorDto,
  UpdateClusterExecutionBody,
  type ClusterExecutionSettingsDtoT
} from '../dto/index.js'

function settingsDto(settings: ClusterExecutionSettings, controlNamespace: string): ClusterExecutionSettingsDtoT {
  return {
    enabled: settings.enabled,
    resourceName: settings.resourceName,
    controlNamespace,
    suspend: settings.suspend,
    daemonImage: settings.daemonImage,
    daemonTier: settings.daemonTier,
    credentialSecretName: settings.credentialSecretName,
    ...(settings.credentialRevision ? { credentialRevision: settings.credentialRevision } : {}),
    runtimeImage: settings.runtimeImage,
    runtimeTiers: settings.runtimeTiers,
    quota: settings.quota,
    egressPolicy: settings.egressPolicy,
    updatedAt: settings.updatedAt.toISOString()
  }
}

export function clusterExecutionRoutes(deps: HttpDeps) {
  return async function clusterExecutionRoutesPlugin(app: FastifyInstance): Promise<void> {
    const cluster: ClusterExecutionService | undefined = deps.clusterExecution
    if (!cluster) return // not configured — no routes, the surface 404s
    const r = app.withTypeProvider<ZodTypeProvider>()

    r.get(
      '/cluster-execution',
      {
        schema: {
          tags: [Tag.Cluster],
          summary: 'Get cluster execution settings',
          description:
            'The organization’s managed-execution envelope settings. An organization that never enabled cluster execution reads the deployment defaults with `enabled: false`, so the console can render the form before the first write.',
          operationId: 'getClusterExecution',
          response: { 200: ClusterExecutionSettingsDto }
        }
      },
      async (req) => settingsDto(await cluster.settings(orgOf(req)), cluster.controlNamespace)
    )

    r.put(
      '/cluster-execution',
      {
        schema: {
          tags: [Tag.Cluster],
          summary: 'Update cluster execution settings',
          description:
            'Owner-only. Persists the settings and reconciles the organization’s AgentConnectOrg resource. `enabled: true` creates or converges it; `enabled: false` DELETES it, which hands the envelope — namespace included — to the operator’s deletion finalizer. Use `suspend` to quiesce without tearing down. `resourceName` and `credentialSecretName` are fixed at first enable and cannot be changed; the envelope namespace is derived by the operator and read back from the status endpoint.',
          operationId: 'updateClusterExecution',
          body: UpdateClusterExecutionBody,
          response: { 200: ClusterExecutionSettingsDto, 403: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        try {
          const settings = await cluster.configure(orgOf(req), req.body)
          return settingsDto(settings, cluster.controlNamespace)
        } catch (error) {
          return sendClusterFailure(reply, error, 'cluster API rejected the request')
        }
      }
    )

    r.post(
      '/cluster-execution/ensure',
      {
        schema: {
          tags: [Tag.Cluster],
          summary: 'Ensure the organization’s envelope exists',
          description:
            'Owner-only, idempotent. Provisions the organization’s AgentConnectOrg resource if it has none — the same thing organization creation does, repeated here so an organization created before this deployment (or outside `POST /orgs`) converges when its owner opens the console. Re-applies the spec when a resource is missing, and issues (or reissues) the daemon credential once the operator has published the envelope namespace. An organization whose owner switched cluster execution OFF is left alone; nothing here re-enables it. `settled: false` means work is still owed — the namespace is not ready, or another caller owns the credential transition — and the caller should repeat the call; it is not an error, and no settings field carries that meaning on its own.',
          operationId: 'ensureClusterExecution',
          response: { 200: ClusterEnsureResultDto, 403: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        try {
          const { settings, settled } = await cluster.ensureProvisioned(orgOf(req), req.principal?.userId)
          return { ...settingsDto(settings, cluster.controlNamespace), settled }
        } catch (error) {
          return sendClusterFailure(reply, error, 'cluster API rejected the request')
        }
      }
    )

    r.post(
      '/cluster-execution/credential',
      {
        schema: {
          tags: [Tag.Cluster],
          summary: 'Issue or rotate the envelope’s daemon credential',
          description:
            'Owner-only, and only while cluster execution is enabled. Mints the organization’s daemon API key, publishes it as the `config.json` entry of the Secret named by the AgentConnectOrg spec, and bumps `credentialRevision` so the operator recreates the daemon pod on the new credential. The key itself is never returned — it exists only inside the cluster Secret. Repeating the call rotates: the new key is published before the old one is revoked, and the daemon identity is reused so the organization’s sessions and agents survive the rotation. Exactly one rotation runs at a time. 409 carries `code`: `CLUSTER_NOT_ENABLED`, `CLUSTER_NAMESPACE_NOT_READY` (the operator has not created the envelope namespace yet — retry once `NamespaceReady` is true), or `CLUSTER_ROTATION_IN_PROGRESS`.',
          operationId: 'issueClusterExecutionCredential',
          response: { 201: ClusterCredentialDto, 403: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        try {
          return reply.code(201).send(await cluster.issueCredential(orgOf(req), req.principal?.userId))
        } catch (error) {
          if (error instanceof ClusterNotEnabledError) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: error.message,
              code: 'CLUSTER_NOT_ENABLED'
            })
          }
          if (error instanceof NamespaceNotReadyError) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: error.message,
              code: 'CLUSTER_NAMESPACE_NOT_READY'
            })
          }
          if (error instanceof ClusterRotationInProgressError) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: error.message,
              code: 'CLUSTER_ROTATION_IN_PROGRESS'
            })
          }
          return sendClusterFailure(reply, error, 'cluster API rejected the request')
        }
      }
    )

    r.get(
      '/cluster-execution/status',
      {
        schema: {
          tags: [Tag.Cluster],
          summary: 'Get cluster envelope status',
          description:
            'Live status read from the organization’s AgentConnectOrg resource — the operator-owned conditions (Ready, NamespaceReady, CredentialReady, LimitsApplied, Progressing, Degraded), daemon/sandbox/pool summaries, and rollout progress. `present: false` means no resource exists yet. Never served from the control-plane database.',
          operationId: 'getClusterExecutionStatus',
          response: { 200: ClusterEnvelopeStatusDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        try {
          return await cluster.status(orgOf(req))
        } catch (error) {
          return sendClusterFailure(reply, error, 'cluster API rejected the request')
        }
      }
    )
  }
}

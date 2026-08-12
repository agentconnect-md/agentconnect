/**
 * Managed cluster execution (docs/designs/agentconnect-org-operator.md).
 *
 *   GET  /orgs/:orgId/cluster-execution         — the org's envelope settings
 *   PUT  /orgs/:orgId/cluster-execution         — owner-only; write + reconcile
 *   POST /orgs/:orgId/cluster-execution/ensure  — owner-only; idempotent provision
 *   GET  /orgs/:orgId/cluster-execution/status  — live status from the resource
 *
 * The settings row is desired state; the resource is the truth. So the write
 * path persists first and then applies, and the status path never reads the
 * database for anything the operator owns. Nothing is delivered to the envelope
 * beyond that one resource — its daemon authenticates with the token the kubelet
 * projects into its pod. Absent cluster configuration ⇒ the plugin registers
 * nothing and the whole surface 404s.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { Tag } from '../plugins/openapi.js'
import { denyNonOwner, orgOf } from '../rbac.js'
import { sendClusterFailure } from '../cluster-failure.js'
import { ClusterTransitionInProgressError, type ClusterExecutionService } from '../../cluster/index.js'
import type { ClusterExecutionSettings } from '../../persistence/ports.js'
import {
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
    runtimeImage: settings.runtimeImage,
    runtimeTiers: settings.runtimeTiers,
    quota: settings.quota,
    egressPolicy: settings.egressPolicy,
    updatedAt: settings.updatedAt.toISOString()
  }
}

/** A peer owning the envelope transition is a retry, not a fault: it is the one
 *  refusal both write paths can answer with that says nothing else is wrong. */
function sendWriteFailure(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ClusterTransitionInProgressError) {
    return reply.code(409).send({
      error: 'Conflict',
      statusCode: 409,
      message: error.message,
      code: 'CLUSTER_TRANSITION_IN_PROGRESS'
    })
  }
  return sendClusterFailure(reply, error, 'cluster API rejected the request')
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
            'Owner-only. Persists the settings and reconciles the organization’s AgentConnectOrg resource. `enabled: true` creates or converges it; `enabled: false` DELETES it, which hands the envelope — namespace included — to the operator’s deletion finalizer. Use `suspend` to quiesce without tearing down. `resourceName` is fixed at first enable and cannot be changed; the envelope namespace is derived by the operator and read back from the status endpoint. 409 `CLUSTER_TRANSITION_IN_PROGRESS` means another caller is switching this envelope on or off — retry.',
          operationId: 'updateClusterExecution',
          body: UpdateClusterExecutionBody,
          response: { 200: ClusterExecutionSettingsDto, 403: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        try {
          const settings = await cluster.configure(orgOf(req), req.body)
          return settingsDto(settings, cluster.controlNamespace)
        } catch (error) {
          return sendWriteFailure(reply, error)
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
            'Owner-only, idempotent. Provisions the organization’s AgentConnectOrg resource if it has none — the same thing organization creation does, repeated here so an organization created before this deployment (or outside `POST /orgs`) converges when its owner opens the console. Re-applies the spec when a resource is missing. An organization whose owner switched cluster execution OFF is left alone; nothing here re-enables it. A 2xx means the resource is applied and nothing further is owed: the envelope’s daemon presents its own projected ServiceAccount token, so there is no credential to come back for.',
          operationId: 'ensureClusterExecution',
          response: { 200: ClusterExecutionSettingsDto, 403: ErrorDto, 409: ErrorDto, 502: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        try {
          return settingsDto(await cluster.ensureProvisioned(orgOf(req)), cluster.controlNamespace)
        } catch (error) {
          return sendWriteFailure(reply, error)
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
            'Live status read from the organization’s AgentConnectOrg resource — the operator-owned conditions (Ready, NamespaceReady, LimitsApplied, Progressing, Degraded), daemon/sandbox/pool summaries, and rollout progress. `present: false` means no resource exists yet. Never served from the control-plane database.',
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

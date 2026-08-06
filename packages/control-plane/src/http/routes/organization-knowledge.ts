import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import {
  ORGANIZATION_KNOWLEDGE_FEATURE,
  ORGANIZATION_SUGGESTION_REVIEW_FEATURE,
  organizationSuggestionCanonical,
  type OrganizationSuggestionContentBody
} from '@agentconnect.md/protocol'
import type { ZodTypeProvider } from '../plugins/zod.js'
import { Tag } from '../plugins/openapi.js'
import type { HttpDeps } from '../deps.js'
import { ctxOf, denyNonOwner, orgOf } from '../rbac.js'
import { AgentId, DaemonId, type OrgId } from '../../domain/ids.js'
import { NoConnection } from '../../orchestrator/outbound.js'
import { ProtocolError } from '../../domain/errors.js'
import { ConnectionClosed } from '../../ws/registry.js'
import { packageSkillBundle, SkillBundleValidationError } from '../../organization-knowledge/skill-bundle.js'
import { organizationSuggestionSnapshotToken } from '../../organization-knowledge/suggestion-snapshot.js'
import type {
  ManagedSkillRecord,
  ManagedSkillRevisionRecord,
  OrganizationKnowledgeRecord,
  OrganizationKnowledgeRevisionRecord,
  OrganizationSuggestionRecord
} from '../../persistence/ports.js'
import {
  CreateOrganizationKnowledgeBody,
  ErrorDto,
  IdParam,
  ManagedSkillDto,
  ManagedSkillListDto,
  ManagedSkillRevisionListDto,
  OrganizationKnowledgeDto,
  OrganizationKnowledgeListDto,
  OrganizationKnowledgeRevisionListDto,
  OrganizationSuggestionContentDto,
  OrganizationSuggestionDto,
  OrganizationSuggestionListDto,
  OrganizationSuggestionListQuery,
  ReviewOrganizationSuggestionBody,
  SetOrganizationArtifactArchivedBody,
  UpdateOrganizationKnowledgeBody
} from '../dto/index.js'

const IncludeArchivedQuery = z.object({ includeArchived: z.stringbool().default(false) })

function knowledgeDto(row: OrganizationKnowledgeRecord, canManage: boolean) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    summary: row.summary,
    tags: row.tags,
    currentRevision: row.currentRevision,
    digest: row.digest,
    source: row.source,
    sourceAgentId: row.sourceAgentId,
    sourceDreamId: row.sourceDreamId,
    sourceSessionIds: row.sourceSessionIds,
    createdByUserId: row.createdByUserId,
    reviewedByUserId: row.reviewedByUserId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    revisionCreatedAt: row.revisionCreatedAt.toISOString(),
    canManage
  }
}

function skillDto(row: ManagedSkillRecord, canManage: boolean) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    currentRevision: row.currentRevision,
    digest: row.digest,
    compressedBytes: row.compressedBytes,
    expandedBytes: row.expandedBytes,
    fileCount: row.fileCount,
    manifest: row.manifest,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canManage
  }
}

function suggestionDto(row: OrganizationSuggestionRecord, sourceAgentName: string | null, contentAvailable: boolean) {
  return {
    id: row.id,
    sourceAgentId: row.sourceAgentId,
    sourceAgentName,
    sourceDaemonId: row.sourceDaemonId,
    dreamId: row.dreamId,
    candidateId: row.candidateId,
    kind: row.kind,
    operation: row.operation,
    targetArtifactId: row.targetArtifactId,
    targetRevision: row.targetRevision,
    title: row.title,
    summary: row.summary,
    tags: row.tags,
    digest: row.digest,
    contentBytes: row.contentBytes,
    sessionIds: row.sessionIds,
    state: row.state,
    contentAvailable,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewReason: row.reviewReason,
    acceptedArtifactId: row.acceptedArtifactId,
    acceptedArtifactRevision: row.acceptedArtifactRevision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function knowledgeRevisionDto(row: OrganizationKnowledgeRevisionRecord) {
  return {
    knowledgeId: row.knowledgeId,
    revision: row.revision,
    content: row.content,
    summary: row.summary,
    tags: row.tags,
    digest: row.digest,
    source: row.source,
    sourceAgentId: row.sourceAgentId,
    sourceDreamId: row.sourceDreamId,
    sourceSessionIds: row.sourceSessionIds,
    createdByUserId: row.createdByUserId,
    reviewedByUserId: row.reviewedByUserId,
    createdAt: row.createdAt.toISOString()
  }
}

function skillRevisionDto(row: ManagedSkillRevisionRecord) {
  return {
    managedSkillId: row.managedSkillId,
    revision: row.revision,
    digest: row.digest,
    compressedBytes: row.compressedBytes,
    expandedBytes: row.expandedBytes,
    fileCount: row.fileCount,
    manifest: row.manifest,
    source: row.source,
    sourceAgentId: row.sourceAgentId,
    sourceDreamId: row.sourceDreamId,
    sourceSessionIds: row.sourceSessionIds,
    createdByUserId: row.createdByUserId,
    reviewedByUserId: row.reviewedByUserId,
    createdAt: row.createdAt.toISOString()
  }
}

function missing(reply: FastifyReply, message = 'organization artifact not found') {
  return reply.code(404).send({ error: 'Not Found', statusCode: 404, message })
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: 'Service Unavailable',
    statusCode: 503,
    message: 'the source daemon is offline or has paused organization-suggestion review; content remains staged there'
  })
}

async function suggestionReviewAvailable(
  deps: HttpDeps,
  orgId: OrgId,
  sourceDaemonId: string | null,
  sourceAgentId: string
): Promise<boolean> {
  if (!sourceDaemonId) return false
  const live = deps.liveness.get(sourceDaemonId)
  if (live?.reachable !== true || live.state !== 'READY') return false
  const [daemon, agent] = await Promise.all([
    deps.registry.get(DaemonId(sourceDaemonId)),
    deps.repos.agent.get(orgId, AgentId(sourceAgentId))
  ])
  return (
    agent?.daemonId === sourceDaemonId &&
    daemon?.capabilities.features.includes(ORGANIZATION_KNOWLEDGE_FEATURE) === true &&
    daemon.capabilities.features.includes(ORGANIZATION_SUGGESTION_REVIEW_FEATURE)
  )
}

function suggestionReadUnavailable(err: unknown): boolean {
  return err instanceof NoConnection || err instanceof ConnectionClosed || err instanceof ProtocolError
}

function suggestionContentMatches(
  suggestion: OrganizationSuggestionRecord,
  digest: string,
  body: OrganizationSuggestionContentBody
): boolean {
  if (digest !== suggestion.digest || body.kind !== suggestion.kind) return false
  const canonical = organizationSuggestionCanonical(body)
  if (Buffer.byteLength(canonical) !== suggestion.contentBytes) return false
  if (body.kind === 'knowledge') {
    return (
      (body.summary ?? null) === suggestion.summary &&
      JSON.stringify(body.tags ?? []) === JSON.stringify(suggestion.tags)
    )
  }
  return true
}

export function organizationKnowledgeRoutes(deps: HttpDeps) {
  return async function organizationKnowledgeRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const repo = deps.repos.organizationKnowledge

    const fanOutManagedSkill = async (orgId: OrgId, managedSkillId: string): Promise<void> => {
      const agents = (await deps.repos.agent.list(orgId)).filter((agent) =>
        agent.managedSkills.includes(managedSkillId)
      )
      await Promise.all(
        agents.map(async (agent) => {
          if (!agent.daemonId) return
          try {
            const spec = await deps.agentSpecs.assemble(agent)
            await deps.control.agentUpsert(agent.daemonId, { agentId: agent.id, spec })
          } catch (err) {
            app.log.warn({ err, agentId: agent.id }, 'managed-skill fan-out deferred to reconnect roster')
          }
        })
      )
    }

    r.get(
      '/knowledge',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'List accepted organization knowledge',
          description: 'Lists the current accepted knowledge revision visible to every member of the organization.',
          operationId: 'listOrganizationKnowledge',
          querystring: IncludeArchivedQuery,
          response: { 200: OrganizationKnowledgeListDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!repo) return unavailable(reply)
        const rows = await repo.listKnowledge(orgOf(req), req.query.includeArchived)
        const canManage = ctxOf(req).role === 'owner'
        return rows.map((row) => knowledgeDto(row, canManage))
      }
    )

    r.post(
      '/knowledge',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Publish organization knowledge manually',
          description: 'Publishes the first immutable revision of an owner-authored organization knowledge entry.',
          operationId: 'createOrganizationKnowledge',
          body: CreateOrganizationKnowledgeBody,
          response: { 201: OrganizationKnowledgeDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!repo) return unavailable(reply)
        const row = await repo.createKnowledge(orgOf(req), req.body, {
          source: 'manual',
          createdByUserId: ctxOf(req).userId
        })
        return reply.code(201).send(knowledgeDto(row, true))
      }
    )

    r.get(
      '/knowledge/:id',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Get organization knowledge',
          description: 'Returns the current accepted revision of one organization knowledge entry.',
          operationId: 'getOrganizationKnowledge',
          params: IdParam,
          response: { 200: OrganizationKnowledgeDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!repo) return unavailable(reply)
        const row = await repo.getKnowledge(req.params.id)
        if (!row || row.orgId !== orgOf(req)) return missing(reply)
        return knowledgeDto(row, ctxOf(req).role === 'owner')
      }
    )

    r.patch(
      '/knowledge/:id',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Publish a new immutable knowledge revision',
          description: 'Publishes an owner-authored revision using optimistic revision fencing.',
          operationId: 'updateOrganizationKnowledge',
          params: IdParam,
          body: UpdateOrganizationKnowledgeBody,
          response: { 200: OrganizationKnowledgeDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!repo) return unavailable(reply)
        const existing = await repo.getKnowledge(req.params.id)
        if (!existing || existing.orgId !== orgOf(req)) return missing(reply)
        const { expectedRevision, ...body } = req.body
        const row = await repo.updateKnowledge(req.params.id, expectedRevision, body, {
          source: 'manual',
          createdByUserId: ctxOf(req).userId
        })
        if (!row) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'knowledge changed since it was loaded; refresh before publishing'
          })
        }
        return knowledgeDto(row, true)
      }
    )

    r.get(
      '/knowledge/:id/revisions',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'List immutable organization knowledge revisions',
          description: 'Lists every immutable revision and its provenance, newest first.',
          operationId: 'listOrganizationKnowledgeRevisions',
          params: IdParam,
          response: { 200: OrganizationKnowledgeRevisionListDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!repo) return unavailable(reply)
        const existing = await repo.getKnowledge(req.params.id)
        if (!existing || existing.orgId !== orgOf(req)) return missing(reply)
        return (await repo.listKnowledgeRevisions(existing.id)).map(knowledgeRevisionDto)
      }
    )

    r.post(
      '/knowledge/:id/archive',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Archive or restore organization knowledge',
          description: 'Archives or restores an organization knowledge entry without deleting its revisions.',
          operationId: 'archiveOrganizationKnowledge',
          params: IdParam,
          body: SetOrganizationArtifactArchivedBody,
          response: { 200: OrganizationKnowledgeDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!repo) return unavailable(reply)
        const existing = await repo.getKnowledge(req.params.id)
        if (!existing || existing.orgId !== orgOf(req)) return missing(reply)
        const row = await repo.setKnowledgeArchived(req.params.id, req.body.archived, ctxOf(req).userId)
        return knowledgeDto(row, true)
      }
    )

    r.get(
      '/managed-skills',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'List accepted managed Agent Skills bundles',
          description: 'Lists current centrally approved managed Agent Skills bundles for the organization.',
          operationId: 'listManagedSkills',
          querystring: IncludeArchivedQuery,
          response: { 200: ManagedSkillListDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!repo) return unavailable(reply)
        const rows = await repo.listManagedSkills(orgOf(req), req.query.includeArchived)
        const canManage = ctxOf(req).role === 'owner'
        return rows.map((row) => skillDto(row, canManage))
      }
    )

    r.get(
      '/managed-skills/:id',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Get a managed Agent Skills bundle',
          description: 'Returns the current approved metadata for one managed Agent Skills bundle.',
          operationId: 'getManagedSkill',
          params: IdParam,
          response: { 200: ManagedSkillDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!repo) return unavailable(reply)
        const row = await repo.getManagedSkill(req.params.id)
        if (!row || row.orgId !== orgOf(req)) return missing(reply, 'managed skill not found')
        return skillDto(row, ctxOf(req).role === 'owner')
      }
    )

    r.get(
      '/managed-skills/:id/revisions',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'List immutable managed skill revisions',
          description: 'Lists every immutable managed-skill revision with bundle metadata and provenance.',
          operationId: 'listManagedSkillRevisions',
          params: IdParam,
          response: { 200: ManagedSkillRevisionListDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!repo) return unavailable(reply)
        const existing = await repo.getManagedSkill(req.params.id)
        if (!existing || existing.orgId !== orgOf(req)) return missing(reply, 'managed skill not found')
        return (await repo.listManagedSkillRevisions(existing.id)).map(skillRevisionDto)
      }
    )

    r.post(
      '/managed-skills/:id/archive',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Archive or restore a managed Agent Skills bundle',
          description: 'Archives or restores a managed skill and reconciles agents that enable it.',
          operationId: 'archiveManagedSkill',
          params: IdParam,
          body: SetOrganizationArtifactArchivedBody,
          response: { 200: ManagedSkillDto, 403: ErrorDto, 404: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!repo) return unavailable(reply)
        const existing = await repo.getManagedSkill(req.params.id)
        if (!existing || existing.orgId !== orgOf(req)) return missing(reply, 'managed skill not found')
        const row = await repo.setManagedSkillArchived(req.params.id, req.body.archived, ctxOf(req).userId)

        // Reconcile every enabling placed agent. Offline/error fan-out is best
        // effort; register/ok remains the durable reconnect backstop.
        await fanOutManagedSkill(orgOf(req), row.id)
        return skillDto(row, true)
      }
    )

    r.get(
      '/knowledge-suggestions',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'List retained Dream suggestions',
          description: 'Lists owner-reviewable Dream suggestion metadata retained by the control plane.',
          operationId: 'listOrganizationKnowledgeSuggestions',
          querystring: OrganizationSuggestionListQuery,
          response: { 200: OrganizationSuggestionListDto, 403: ErrorDto, 503: ErrorDto }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!repo) return unavailable(reply)
        const rows = await repo.listSuggestions(orgOf(req), req.query)
        const names = new Map<string, string | null>()
        await Promise.all(
          [...new Set(rows.map((row) => row.sourceAgentId))].map(async (id) => {
            const agent = await deps.repos.agent.get(orgOf(req), AgentId(id))
            names.set(id, agent?.displayName ?? agent?.name ?? null)
          })
        )
        const availability = new Map<string, boolean>()
        const availabilityKey = (daemonId: string, agentId: string) => `${daemonId}:${agentId}`
        await Promise.all(
          [
            ...new Map(
              rows.flatMap((row) =>
                row.sourceDaemonId ? [[availabilityKey(row.sourceDaemonId, row.sourceAgentId), row] as const] : []
              )
            ).entries()
          ].map(async ([key, row]) => {
            availability.set(
              key,
              await suggestionReviewAvailable(deps, orgOf(req), row.sourceDaemonId, row.sourceAgentId)
            )
          })
        )
        return rows.map((row) =>
          suggestionDto(
            row,
            names.get(row.sourceAgentId) ?? null,
            row.state === 'pending' &&
              row.sourceDaemonId !== null &&
              availability.get(availabilityKey(row.sourceDaemonId, row.sourceAgentId)) === true
          )
        )
      }
    )

    r.get(
      '/knowledge-suggestions/:id/content',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Read one daemon-local suggestion body',
          description: 'Reads and verifies the staged body and returns a token binding the inspected snapshot.',
          operationId: 'readOrganizationKnowledgeSuggestion',
          params: IdParam,
          response: {
            200: OrganizationSuggestionContentDto,
            403: ErrorDto,
            404: ErrorDto,
            409: ErrorDto,
            503: ErrorDto
          }
        }
      },
      async (req, reply) => {
        if (denyNonOwner(req, reply)) return
        if (!repo) return unavailable(reply)
        const suggestion = await repo.getSuggestion(req.params.id)
        if (!suggestion || suggestion.orgId !== orgOf(req)) return missing(reply, 'suggestion not found')
        if (suggestion.state !== 'pending') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'suggestion is already reviewed' })
        }
        if (!suggestion.sourceDaemonId) return unavailable(reply)
        if (!(await suggestionReviewAvailable(deps, orgOf(req), suggestion.sourceDaemonId, suggestion.sourceAgentId))) {
          return unavailable(reply)
        }
        try {
          const content = await deps.control.organizationSuggestionRead(suggestion.sourceDaemonId, {
            sourceAgentId: suggestion.sourceAgentId,
            dreamId: suggestion.dreamId,
            candidateId: suggestion.candidateId,
            kind: suggestion.kind
          })
          if (!content.exists || !content.body || !suggestionContentMatches(suggestion, content.digest, content.body)) {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'the staged suggestion is missing or no longer matches its metadata'
            })
          }
          return content.body.kind === 'knowledge'
            ? {
                kind: 'knowledge' as const,
                digest: content.digest,
                snapshotToken: organizationSuggestionSnapshotToken(suggestion),
                content: content.body.content,
                summary: suggestion.summary,
                tags: suggestion.tags
              }
            : {
                kind: 'skill' as const,
                digest: content.digest,
                snapshotToken: organizationSuggestionSnapshotToken(suggestion),
                files: content.body.files
              }
        } catch (err) {
          if (suggestionReadUnavailable(err)) {
            app.log.warn({ err, suggestionId: suggestion.id }, 'organization suggestion content read unavailable')
            return unavailable(reply)
          }
          throw err
        }
      }
    )

    r.post(
      '/knowledge-suggestions/:id/review',
      {
        schema: {
          tags: [Tag.Knowledge],
          summary: 'Accept or reject one Dream suggestion',
          description: 'Records an owner decision; acceptance requires the exact token returned during inspection.',
          operationId: 'reviewOrganizationKnowledgeSuggestion',
          params: IdParam,
          body: ReviewOrganizationSuggestionBody,
          response: {
            200: OrganizationSuggestionDto,
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
        if (!repo) return unavailable(reply)
        const suggestion = await repo.getSuggestion(req.params.id)
        if (!suggestion || suggestion.orgId !== orgOf(req)) return missing(reply, 'suggestion not found')
        if (suggestion.state !== 'pending') {
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'suggestion is already reviewed' })
        }

        if (req.body.decision === 'reject') {
          if (!suggestion.sourceDaemonId) return unavailable(reply)
          if (
            !(await suggestionReviewAvailable(deps, orgOf(req), suggestion.sourceDaemonId, suggestion.sourceAgentId))
          ) {
            return unavailable(reply)
          }
          const rejected = await repo.rejectSuggestion(suggestion.id, ctxOf(req).userId, req.body.reason)
          if (rejected.state !== 'rejected') {
            return reply.code(409).send({
              error: 'Conflict',
              statusCode: 409,
              message: 'suggestion was reviewed concurrently; refresh before retrying'
            })
          }
          void deps.control
            .organizationSuggestionReview(suggestion.sourceDaemonId, {
              sourceAgentId: suggestion.sourceAgentId,
              dreamId: suggestion.dreamId,
              candidateId: suggestion.candidateId,
              state: 'rejected'
            })
            .catch((err) =>
              app.log.warn(
                { err, suggestionId: suggestion.id, decision: 'rejected' },
                'organization suggestion decision convergence deferred'
              )
            )
          const agent = await deps.repos.agent.get(orgOf(req), AgentId(suggestion.sourceAgentId))
          return suggestionDto(rejected, agent?.displayName ?? agent?.name ?? null, false)
        }

        if (req.body.snapshotToken !== organizationSuggestionSnapshotToken(suggestion)) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'suggestion metadata changed after it was inspected; refresh and inspect it again'
          })
        }

        if (!suggestion.sourceDaemonId) return unavailable(reply)
        if (!(await suggestionReviewAvailable(deps, orgOf(req), suggestion.sourceDaemonId, suggestion.sourceAgentId))) {
          return unavailable(reply)
        }
        let content
        try {
          content = await deps.control.organizationSuggestionRead(suggestion.sourceDaemonId, {
            sourceAgentId: suggestion.sourceAgentId,
            dreamId: suggestion.dreamId,
            candidateId: suggestion.candidateId,
            kind: suggestion.kind
          })
        } catch (err) {
          if (suggestionReadUnavailable(err)) {
            app.log.warn({ err, suggestionId: suggestion.id }, 'organization suggestion acceptance read unavailable')
            return unavailable(reply)
          }
          throw err
        }
        if (!content.exists || !content.body || !suggestionContentMatches(suggestion, content.digest, content.body)) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            message: 'the staged suggestion is missing or no longer matches its metadata'
          })
        }

        let result
        try {
          if (suggestion.kind === 'knowledge' && content.body.kind === 'knowledge') {
            result = await repo.acceptKnowledgeSuggestion(
              suggestion.id,
              {
                title: suggestion.title,
                content: content.body.content,
                summary: suggestion.summary,
                tags: suggestion.tags
              },
              req.body.snapshotToken,
              ctxOf(req).userId
            )
          } else if (suggestion.kind === 'skill' && content.body.kind === 'skill') {
            const bundle = packageSkillBundle(content.body.files, suggestion.title)
            result = await repo.acceptSkillSuggestion(
              suggestion.id,
              { ...bundle, name: suggestion.title, candidateDigest: content.digest },
              req.body.snapshotToken,
              ctxOf(req).userId
            )
          } else {
            return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: 'suggestion kind mismatch' })
          }
        } catch (err) {
          if (err instanceof SkillBundleValidationError) {
            return reply.code(400).send({ error: 'Bad Request', statusCode: 400, message: err.message })
          }
          throw err
        }

        if (result.outcome !== 'accepted') {
          const reason =
            result.outcome === 'not_pending'
              ? 'suggestion is already reviewed'
              : result.outcome === 'metadata_changed'
                ? 'suggestion metadata changed while it was inspected; refresh and inspect it again'
                : result.outcome === 'stale_target'
                  ? 'the target has a newer revision; regenerate the suggestion'
                  : result.outcome === 'target_missing'
                    ? 'the target artifact no longer exists'
                    : 'a managed skill with this name already exists'
          return reply.code(409).send({ error: 'Conflict', statusCode: 409, message: reason })
        }

        if (suggestion.kind === 'skill' && result.suggestion.acceptedArtifactId) {
          await fanOutManagedSkill(orgOf(req), result.suggestion.acceptedArtifactId)
        }

        void deps.control
          .organizationSuggestionReview(suggestion.sourceDaemonId, {
            sourceAgentId: suggestion.sourceAgentId,
            dreamId: suggestion.dreamId,
            candidateId: suggestion.candidateId,
            state: 'accepted'
          })
          .catch((err) =>
            app.log.warn(
              { err, suggestionId: suggestion.id, decision: 'accepted' },
              'organization suggestion decision convergence deferred'
            )
          )
        const agent = await deps.repos.agent.get(orgOf(req), AgentId(suggestion.sourceAgentId))
        return suggestionDto(result.suggestion, agent?.displayName ?? agent?.name ?? null, false)
      }
    )
  }
}

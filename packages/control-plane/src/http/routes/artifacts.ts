// Artifact reads (artifacts.md §6.3, §8.1): every route answers 404 for an artifact the viewer is not in the audience of.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import { canViewArtifact, isArtifactOwner, type ArtifactViewer } from '../../authorization/artifact-policy.js'
import type { ArtifactRecord, ArtifactRevisionRecord } from '../../persistence/ports.js'
import { makeSessionAccessResolver } from '../session-access.js'
import {
  ArtifactDto,
  ArtifactFileQuery,
  ArtifactFileUrlDto,
  ArtifactParams,
  ArtifactRevisionDto,
  ArtifactRevisionParams,
  ErrorDto
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

const notFound = { error: 'Not Found', statusCode: 404, message: 'artifact not found' }
// Without a bucket and a content domain (artifacts.md §12); deployment-wide, so it reveals nothing about one artifact.
const notEnabled = {
  error: 'Conflict',
  statusCode: 409,
  code: 'ARTIFACTS_NOT_ENABLED',
  message: 'artifacts are not enabled on this deployment'
}

function revisionSummary(revision: ArtifactRevisionRecord) {
  const entry = revision.manifest.files.find((f) => f.path === revision.manifest.entry)
  return {
    number: revision.number,
    entry: revision.manifest.entry,
    entryMediaType: entry?.mediaType ?? 'application/octet-stream',
    fileCount: revision.fileCount,
    totalBytes: revision.totalBytes,
    producedBy: { agentId: revision.producedByAgentId, name: revision.producedByAgentName },
    producedInSessionId: revision.producedInSessionId,
    createdAt: revision.createdAt.toISOString()
  }
}

export function artifactRoutes(deps: HttpDeps) {
  return async function artifactRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const sessionAccess = makeSessionAccessResolver(deps)

    /** The artifact when it has a ready revision and the request's member is in its audience, with that member as a viewer. */
    const visible = async (
      req: FastifyRequest,
      artifactId: string
    ): Promise<{ artifact: ArtifactRecord; viewer: ArtifactViewer } | null> => {
      const artifact = await deps.repos.artifact.get(orgOf(req), artifactId)
      if (!artifact || artifact.latestRevision === 0) return null
      // The session resolver answers the same external and editors questions for an artifact's copied audience.
      const access = await sessionAccess.forSessions(req, [
        {
          visibility: artifact.visibility,
          externalProvider: artifact.externalProvider,
          externalScopeId: artifact.externalScopeId,
          ...(artifact.editorsAgentId ? { agentId: artifact.editorsAgentId } : {})
        }
      ])
      const viewer: ArtifactViewer = {
        orgId: orgOf(req),
        principal: ctxOf(req),
        identitySet: access.identitySet,
        externalAccess: access.externalAccess,
        editableAgentIds: access.editableAgentIds
      }
      return canViewArtifact(artifact, viewer) ? { artifact, viewer } : null
    }

    /** A ready revision of a visible artifact. */
    const visibleRevision = async (req: FastifyRequest, artifactId: string, number: number) => {
      const found = await visible(req, artifactId)
      if (!found) return null
      const revision = await deps.repos.artifact.getRevision(orgOf(req), artifactId, number)
      return revision?.state === 'ready' ? { ...found, revision } : null
    }

    r.get(
      '/artifacts/:artifactId',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Get an artifact',
          description:
            'An artifact’s title, owner, audience and ready revisions, newest first, each with its entry file, size and the agent that produced it. The caller must be an organization member in the artifact’s audience; anything else, including an artifact whose first revision is not ready yet, is not found. Every artifact route answers 409 `ARTIFACTS_NOT_ENABLED` on a deployment without a transfer bucket and a content domain.',
          operationId: 'getArtifact',
          params: ArtifactParams,
          response: { 200: ArtifactDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await visible(req, req.params.artifactId)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, viewer } = found
        const revisions = await deps.repos.artifact.listRevisions(orgOf(req), artifact.id)
        let owner = null
        if (artifact.ownerIdentity?.startsWith('user:')) {
          const userId = artifact.ownerIdentity.slice('user:'.length)
          const member = await deps.repos.user.activeMember(orgOf(req), userId)
          owner = { userId, displayName: member?.displayName ?? null, email: member?.email ?? null, platform: null }
        } else if (artifact.ownerIdentity) {
          const platform = artifact.ownerIdentity.slice(0, artifact.ownerIdentity.indexOf(':')) || null
          owner = { userId: null, displayName: null, email: null, platform }
        }
        return {
          id: artifact.id,
          title: artifact.title,
          audience: {
            visibility: artifact.visibility,
            externalProvider: artifact.externalProvider,
            editorsAgentId: artifact.editorsAgentId
          },
          owner,
          viewerIsOwner: isArtifactOwner(artifact, viewer.identitySet),
          originSessionId: artifact.originSessionId,
          latestRevision: artifact.latestRevision,
          createdAt: artifact.createdAt.toISOString(),
          updatedAt: artifact.updatedAt.toISOString(),
          revisions: revisions.map(revisionSummary)
        }
      }
    )

    r.get(
      '/artifacts/:artifactId/revisions/:revision',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Get an artifact revision',
          description:
            'One ready revision’s manifest: its entry path and every file’s relative path, SHA-256, size and media type. The caller must be an organization member in the artifact’s audience. Not found for a revision that is pending, was never published, or has been removed.',
          operationId: 'getArtifactRevision',
          params: ArtifactRevisionParams,
          response: { 200: ArtifactRevisionDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await visibleRevision(req, req.params.artifactId, req.params.revision)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, revision } = found
        return {
          ...revisionSummary(revision),
          artifactId: artifact.id,
          latestRevision: artifact.latestRevision,
          manifest: revision.manifest
        }
      }
    )

    r.get(
      '/artifacts/:artifactId/revisions/:revision/file',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Get a signed download for an artifact file',
          description:
            'A short-lived signed URL for one file of a ready revision, named by its manifest path. The object store serves it as an `application/octet-stream` attachment, so nothing renders on the store’s origin; the console fetches the bytes and renders them itself by the manifest’s media type. The caller must be an organization member in the artifact’s audience. Not found when the path is not in the manifest.',
          operationId: 'getArtifactFileUrl',
          params: ArtifactRevisionParams,
          querystring: ArtifactFileQuery,
          response: { 200: ArtifactFileUrlDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        const artifacts = deps.artifacts
        if (!artifacts) return reply.code(409).send(notEnabled)
        const found = await visibleRevision(req, req.params.artifactId, req.params.revision)
        const file = found?.revision.manifest.files.find((f) => f.path === req.query.path)
        if (!found || !file) return reply.code(404).send(notFound)
        const get = await artifacts.fileDownload(found.revision, file.path)
        if (!get) return reply.code(404).send(notFound)
        return { ...file, url: get.url, expiresAt: new Date(get.expiresAt).toISOString() }
      }
    )
  }
}

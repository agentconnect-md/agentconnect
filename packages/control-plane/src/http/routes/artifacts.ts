// Artifact reads, the Artifacts page and share management (artifacts.md §6.3, §8.1, §8.3, §11.5): an artifact the caller may not act on reads as 404.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { orgOf, ctxOf } from '../rbac.js'
import {
  ArtifactAction,
  canActOnArtifact,
  canRevokeArtifactShare,
  canViewArtifact,
  isArtifactOwner,
  type ArtifactViewer
} from '../../authorization/artifact-policy.js'
import { canViewSession } from '../../authorization/policy.js'
import { SessionId } from '../../domain/ids.js'
import { artifactKind } from '../../artifacts/kind.js'
import type {
  ArtifactListFilter,
  ArtifactRecord,
  ArtifactRevisionRecord,
  ArtifactShareRecord
} from '../../persistence/ports.js'
import { decodeArtifactCursor, encodeArtifactCursor } from '../../persistence/repositories/artifact.repo.js'
import { makeSessionAccessResolver, type SessionAccessSubject } from '../session-access.js'
import {
  ArtifactDto,
  ArtifactListQuery,
  OrgArtifactPageDto,
  OrgArtifactShareListQuery,
  OrgArtifactSharePageDto,
  UpdateArtifactBody,
  ArtifactFileQuery,
  ArtifactFileUrlDto,
  ArtifactParams,
  ArtifactRevisionDto,
  ArtifactRevisionParams,
  ArtifactShareDto,
  ArtifactShareListDto,
  ArtifactShareParams,
  CreateArtifactShareBody,
  CreatedArtifactShareDto,
  ErrorDto,
  UpdateArtifactShareBody,
  SessionArtifactListQuery,
  SessionArtifactPageDto,
  SessionArtifactParams
} from '../dto/index.js'
import { Tag } from '../plugins/openapi.js'

const notFound = { error: 'Not Found', statusCode: 404, message: 'artifact not found' }
const shareNotFound = { error: 'Not Found', statusCode: 404, message: 'share not found' }
const invalidCursor = { error: 'Bad Request', statusCode: 400, message: 'invalid cursor' }
// A type filter applies after the audience query, so a filtered list reads rows in batches, at most this many per request.
const LIST_SCAN_BATCH = 100
const LIST_SCAN_PAGES = 4
// Without a bucket and a content domain (artifacts.md §12); deployment-wide, so it reveals nothing about one artifact.
const notEnabled = {
  error: 'Conflict',
  statusCode: 409,
  code: 'ARTIFACTS_NOT_ENABLED',
  message: 'artifacts are not enabled on this deployment'
}

function entryMediaType(revision: ArtifactRevisionRecord): string {
  const entry = revision.manifest.files.find((f) => f.path === revision.manifest.entry)
  return entry?.mediaType ?? 'application/octet-stream'
}

const kindOf = (revision: ArtifactRevisionRecord) => artifactKind(entryMediaType(revision), revision.manifest.entry)

function revisionSummary(revision: ArtifactRevisionRecord) {
  return {
    number: revision.number,
    entry: revision.manifest.entry,
    entryMediaType: entryMediaType(revision),
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

    /** The request's member as a viewer of these audiences; the session resolver answers the same external and editors questions for a copied audience. */
    const viewerFor = async (
      req: FastifyRequest,
      subjects: readonly SessionAccessSubject[]
    ): Promise<ArtifactViewer> => {
      const access = await sessionAccess.forSessions(req, subjects)
      return {
        orgId: orgOf(req),
        principal: ctxOf(req),
        identitySet: access.identitySet,
        externalAccess: access.externalAccess,
        editableAgentIds: access.editableAgentIds
      }
    }

    /** The request's member as a viewer of `artifacts`. */
    const viewerOf = (req: FastifyRequest, artifacts: readonly ArtifactRecord[]) =>
      viewerFor(
        req,
        artifacts.map((artifact) => ({
          visibility: artifact.visibility,
          externalProvider: artifact.externalProvider,
          externalScopeId: artifact.externalScopeId,
          ...(artifact.editorsAgentId ? { agentId: artifact.editorsAgentId } : {})
        }))
      )

    /** The request's member as a viewer of every audience the organization's artifacts were given, for a list read in SQL. */
    const orgViewerOf = async (req: FastifyRequest): Promise<ArtifactViewer> => {
      const keys = await deps.repos.artifact.audienceKeys(orgOf(req))
      return viewerFor(req, [
        ...keys.externalScopeIds.map((externalScopeId) => ({
          visibility: 'external' as const,
          externalProvider: null,
          externalScopeId
        })),
        ...keys.editorsAgentIds.map((agentId) => ({
          visibility: 'editors' as const,
          externalProvider: null,
          externalScopeId: null,
          agentId
        }))
      ])
    }

    /** The artifact when it has a ready revision and the request's member is in its audience, with that member as a viewer. */
    const visible = async (
      req: FastifyRequest,
      artifactId: string
    ): Promise<{ artifact: ArtifactRecord; viewer: ArtifactViewer } | null> => {
      const artifact = await deps.repos.artifact.get(orgOf(req), artifactId)
      if (!artifact || artifact.latestRevision === 0) return null
      const viewer = await viewerOf(req, [artifact])
      return canViewArtifact(artifact, viewer) ? { artifact, viewer } : null
    }

    type Members = Map<string, ReturnType<typeof deps.repos.user.activeMember>>

    /** A namespaced identity as a person; `members` memoizes member lookups across one request. */
    const personOf = async (req: FastifyRequest, identity: string, members: Members) => {
      if (identity.startsWith('user:')) {
        const userId = identity.slice('user:'.length)
        let lookup = members.get(userId)
        if (!lookup) {
          lookup = deps.repos.user.activeMember(orgOf(req), userId)
          members.set(userId, lookup)
        }
        const member = await lookup
        return { userId, displayName: member?.displayName ?? null, email: member?.email ?? null, platform: null }
      }
      const platform = identity.slice(0, identity.indexOf(':')) || null
      return { userId: null, displayName: null, email: null, platform }
    }

    /** `getArtifact`'s fields other than the revision list. */
    const summaryOf = async (
      req: FastifyRequest,
      artifact: ArtifactRecord,
      viewer: ArtifactViewer,
      members: Members = new Map()
    ) => {
      const owner = artifact.ownerIdentity ? await personOf(req, artifact.ownerIdentity, members) : null
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
        updatedAt: artifact.updatedAt.toISOString()
      }
    }

    /** The session gate the session routes use; an invisible session reads as absent. */
    const sessionVisible = async (req: FastifyRequest, sessionId: string): Promise<boolean> => {
      const session = await deps.repos.session.get(orgOf(req), SessionId(sessionId))
      if (!session) return false
      const access = await sessionAccess.forSessions(req, [session])
      return canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess, access.editableAgentIds)
    }

    /** A ready revision of a visible artifact. */
    const visibleRevision = async (req: FastifyRequest, artifactId: string, number: number) => {
      const found = await visible(req, artifactId)
      if (!found) return null
      const revision = await deps.repos.artifact.getRevision(orgOf(req), artifactId, number)
      return revision?.state === 'ready' ? { ...found, revision } : null
    }

    /** An artifact with a ready revision, whether or not the caller can view it, with the caller as a viewer. */
    const managed = async (
      req: FastifyRequest,
      artifactId: string
    ): Promise<{ artifact: ArtifactRecord; viewer: ArtifactViewer; canView: boolean } | null> => {
      const artifact = await deps.repos.artifact.get(orgOf(req), artifactId)
      if (!artifact || artifact.latestRevision === 0) return null
      const viewer = await viewerOf(req, [artifact])
      return { artifact, viewer, canView: canViewArtifact(artifact, viewer) }
    }

    /** A refused action: 403 to someone who can view the artifact, otherwise it does not exist for them. */
    const refuse = (reply: FastifyReply, canView: boolean, code = 'ARTIFACT_SHARE_FORBIDDEN') =>
      canView
        ? reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            code,
            message: 'only the artifact’s owner or an organization owner can do this'
          })
        : reply.code(404).send(notFound)

    /** Which origin sessions still exist and the caller can view, for the Artifacts page's back link. */
    const visibleSessions = async (req: FastifyRequest, ids: readonly string[]): Promise<Set<string>> => {
      const found = await Promise.all([...new Set(ids)].map((id) => deps.repos.session.get(orgOf(req), SessionId(id))))
      const sessions = found.filter((session) => session !== null)
      if (sessions.length === 0) return new Set()
      const access = await sessionAccess.forSessions(req, sessions)
      return new Set(
        sessions
          .filter((session) =>
            canViewSession(session, ctxOf(req), access.identitySet, access.externalAccess, access.editableAgentIds)
          )
          .map((session) => session.id)
      )
    }

    const shareDto = async (req: FastifyRequest, share: ArtifactShareRecord, members: Members = new Map()) => ({
      id: share.id,
      artifactId: share.artifactId,
      revision: share.revisionNumber,
      audience: share.audience,
      displayTail: share.displayTail,
      createdBy: await personOf(req, share.createdByIdentity, members),
      createdAt: share.createdAt.toISOString(),
      updatedAt: share.updatedAt.toISOString(),
      revokedAt: share.revokedAt?.toISOString() ?? null
    })

    r.get(
      '/artifacts',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'List the organization’s artifacts',
          description:
            'Every artifact the caller can view, most recently updated first, each with `listSessionArtifacts`’s fields plus its `kind`, whether it has an active share and an active `public` one, whether its originating session still exists and is visible to the caller, and which of rename, audience change, `public` sharing and revoking the caller may do. Another member’s private artifact is never listed, even to an organization owner. Filters: `scope=mine` keeps what the caller owns; `agentId` keeps artifacts with a ready revision that agent produced; `type` keeps those whose latest entry opens as `page` (HTML), `document` (Markdown), `image`, `pdf`, `code` (any text, JSON, XML or source) or `other`; `publiclyShared=true` keeps those with an active `public` share. A `type` filter reads at most 400 artifacts per request, so its page may be shorter than `limit`, or empty, and still carry a `nextCursor`. Pass a page’s `nextCursor` back as `cursor` for older artifacts.',
          operationId: 'listArtifacts',
          querystring: ArtifactListQuery,
          response: { 200: OrgArtifactPageDto, 400: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const decoded = req.query.cursor ? decodeArtifactCursor(req.query.cursor) : undefined
        if (decoded === null) return reply.code(400).send(invalidCursor)
        const { limit, type } = req.query
        const viewer = await orgViewerOf(req)
        const filter: ArtifactListFilter = {
          ...(req.query.scope === 'mine' ? { ownerIdentities: [...viewer.identitySet] } : {}),
          ...(req.query.agentId ? { producedByAgentId: req.query.agentId } : {}),
          ...(req.query.publiclyShared ? { publiclyShared: true } : {})
        }
        const picked: Array<{ artifact: ArtifactRecord; latest: ArtifactRevisionRecord }> = []
        let cursor = decoded
        let nextCursor: string | null = null
        const size = type ? Math.max(limit, LIST_SCAN_BATCH) : limit
        for (let scanned = 0; scanned < LIST_SCAN_PAGES; scanned += 1) {
          const rows = await deps.repos.artifact.listVisible(
            viewer,
            { limit: size + 1, ...(cursor ? { cursor } : {}) },
            filter
          )
          const batch = rows.slice(0, size)
          const latest = new Map(
            (await deps.repos.artifact.latestRevisions(orgOf(req), batch)).map((rev) => [rev.artifactId, rev])
          )
          // The index of the row that fills the page, or -1 when the batch runs out first.
          const full = batch.findIndex((artifact) => {
            const rev = latest.get(artifact.id)
            if (rev?.state === 'ready' && (!type || kindOf(rev) === type)) picked.push({ artifact, latest: rev })
            return picked.length === limit
          })
          const last = full >= 0 ? batch[full] : batch.at(-1)
          const more = rows.length > size || (full >= 0 && full < batch.length - 1)
          nextCursor = more && last ? encodeArtifactCursor(last) : null
          if (full >= 0 || !more || !last) break
          cursor = { updatedAt: last.updatedAt, id: last.id }
        }
        const ids = picked.map(({ artifact }) => artifact.id)
        const [audiences, sessions] = await Promise.all([
          deps.artifactShares.activeAudiences(orgOf(req), ids),
          visibleSessions(
            req,
            picked.flatMap(({ artifact }) => (artifact.originSessionId ? [artifact.originSessionId] : []))
          )
        ])
        const members: Members = new Map()
        const artifacts = await Promise.all(
          picked.map(async ({ artifact, latest }) => ({
            ...(await summaryOf(req, artifact, viewer, members)),
            latest: revisionSummary(latest),
            kind: kindOf(latest),
            shared: {
              any: audiences.some((row) => row.artifactId === artifact.id),
              public: audiences.some((row) => row.artifactId === artifact.id && row.audience === 'public')
            },
            originSessionVisible: artifact.originSessionId !== null && sessions.has(artifact.originSessionId),
            permissions: {
              rename: canActOnArtifact(ArtifactAction.Rename, artifact, viewer),
              changeAudience: canActOnArtifact(ArtifactAction.ChangeAudience, artifact, viewer),
              sharePublic: canActOnArtifact(ArtifactAction.SharePublic, artifact, viewer),
              revokeShares: canActOnArtifact(ArtifactAction.RevokeShare, artifact, viewer)
            }
          }))
        )
        return { artifacts, nextCursor }
      }
    )

    r.patch(
      '/artifacts/:artifactId',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Rename an artifact or change its audience',
          description:
            'Sets the title, moves the audience between `private` and `org`, or both, and answers `getArtifact`’s body. The artifact’s owner may do either, and so may an organization owner on an artifact they can view; existing shares are left as they are. An audience copied from an `external` or `editors` session cannot be changed: 409 `ARTIFACT_AUDIENCE_FIXED`, and nothing is applied. 403 `ARTIFACT_UPDATE_FORBIDDEN` for anyone else who can view the artifact; 404 when the caller cannot view it; 409 `ARTIFACT_CHANGED` when its owner or audience changed while the request was decided, to be retried.',
          operationId: 'updateArtifact',
          params: ArtifactParams,
          body: UpdateArtifactBody,
          response: { 200: ArtifactDto, 400: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await managed(req, req.params.artifactId)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, viewer, canView } = found
        if (!canActOnArtifact(ArtifactAction.Rename, artifact, viewer)) {
          return refuse(reply, canView, 'ARTIFACT_UPDATE_FORBIDDEN')
        }
        const { title, audience } = req.body
        if (audience !== undefined && !canActOnArtifact(ArtifactAction.ChangeAudience, artifact, viewer)) {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            code: 'ARTIFACT_AUDIENCE_FIXED',
            message: 'only a private or organization-wide artifact can change its audience'
          })
        }
        // Applied only while the owner and audience are still the ones just authorized against.
        const updated = await deps.repos.artifact.update(
          orgOf(req),
          artifact.id,
          { visibility: artifact.visibility, ownerIdentity: artifact.ownerIdentity },
          { ...(title !== undefined ? { title } : {}), ...(audience !== undefined ? { visibility: audience } : {}) }
        )
        if (!updated) {
          if (!(await deps.repos.artifact.get(orgOf(req), artifact.id))) return reply.code(404).send(notFound)
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            code: 'ARTIFACT_CHANGED',
            message: 'the artifact’s owner or audience changed meanwhile; try again'
          })
        }
        const [summary, revisions] = await Promise.all([
          summaryOf(req, updated, viewer),
          deps.repos.artifact.listRevisions(orgOf(req), updated.id)
        ])
        return { ...summary, revisions: revisions.map(revisionSummary) }
      }
    )

    r.get(
      '/artifact-shares',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'List the organization’s public shares',
          description:
            'For organization owners, who moderate public links: every active `public` share in the organization, newest first, with its revision, creator and creation time and its artifact’s id, title and owner, including artifacts the caller cannot view. It never carries a manifest, a file or a token; `artifact.viewerCanView` says whether the caller may open the artifact. Revoke one through `revokeArtifactShare`, which an organization owner may do without viewing the artifact. 403 `ARTIFACT_MODERATION_FORBIDDEN` for anyone who is not an organization owner. Pass a page’s `nextCursor` back as `cursor` for older shares.',
          operationId: 'listOrgArtifactShares',
          querystring: OrgArtifactShareListQuery,
          response: { 200: OrgArtifactSharePageDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        if (ctxOf(req).role !== 'owner') {
          return reply.code(403).send({
            error: 'Forbidden',
            statusCode: 403,
            code: 'ARTIFACT_MODERATION_FORBIDDEN',
            message: 'only an organization owner can list the organization’s public shares'
          })
        }
        // Shares page by creation time; the artifact cursor's codec carries that time in its `updatedAt` slot.
        const decoded = req.query.cursor ? decodeArtifactCursor(req.query.cursor) : undefined
        if (decoded === null) return reply.code(400).send(invalidCursor)
        const limit = req.query.limit
        const rows = await deps.artifactShares.listActiveInOrg(orgOf(req), req.query.audience, {
          limit: limit + 1,
          ...(decoded ? { cursor: { createdAt: decoded.updatedAt, id: decoded.id } } : {})
        })
        const page = rows.slice(0, limit)
        const viewer = await viewerOf(
          req,
          page.map((row) => row.artifact)
        )
        const members: Members = new Map()
        const shares = await Promise.all(
          page.map(async ({ share, artifact }) => ({
            ...(await shareDto(req, share, members)),
            artifact: {
              id: artifact.id,
              title: artifact.title,
              owner: artifact.ownerIdentity ? await personOf(req, artifact.ownerIdentity, members) : null,
              viewerCanView: canViewArtifact(artifact, viewer)
            }
          }))
        )
        const last = page.at(-1)
        return {
          shares,
          nextCursor:
            rows.length > limit && last
              ? encodeArtifactCursor({ updatedAt: last.share.createdAt, id: last.share.id })
              : null
        }
      }
    )

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
        const [summary, revisions] = await Promise.all([
          summaryOf(req, artifact, viewer),
          deps.repos.artifact.listRevisions(orgOf(req), artifact.id)
        ])
        return { ...summary, revisions: revisions.map(revisionSummary) }
      }
    )

    r.get(
      '/sessions/:sessionId/artifacts',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'List a session’s artifacts',
          description:
            'The artifacts with at least one ready revision published in this session, most recently updated first, each with `getArtifact`’s fields and its latest ready revision, which may have been published elsewhere. The caller must be able to view the session, else it is not found, and only artifacts whose audience includes the caller are listed, so a page can hold fewer than `limit`. Pass a page’s `nextCursor` back as `cursor` for older artifacts.',
          operationId: 'listSessionArtifacts',
          params: SessionArtifactParams,
          querystring: SessionArtifactListQuery,
          response: { 200: SessionArtifactPageDto, 400: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        if (!(await sessionVisible(req, req.params.sessionId))) {
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'session not found' })
        }
        const cursor = req.query.cursor ? decodeArtifactCursor(req.query.cursor) : undefined
        if (cursor === null) return reply.code(400).send(invalidCursor)
        const limit = req.query.limit
        const rows = await deps.repos.artifact.listProducedInSession(orgOf(req), req.params.sessionId, {
          limit: limit + 1,
          ...(cursor ? { cursor } : {})
        })
        const page = rows.slice(0, limit)
        const viewer = await viewerOf(req, page)
        const members: Members = new Map()
        const listed = await Promise.all(
          page
            .filter((artifact) => canViewArtifact(artifact, viewer))
            .map(async (artifact) => {
              const [summary, latest] = await Promise.all([
                summaryOf(req, artifact, viewer, members),
                deps.repos.artifact.getRevision(orgOf(req), artifact.id, artifact.latestRevision)
              ])
              return latest?.state === 'ready' ? { ...summary, latest: revisionSummary(latest) } : null
            })
        )
        const last = page.at(-1)
        return {
          artifacts: listed.filter((entry) => entry !== null),
          nextCursor: rows.length > limit && last ? encodeArtifactCursor(last) : null
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

    r.post(
      '/artifacts/:artifactId/shares',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Share an artifact revision',
          description:
            'Creates a link to one ready revision. An `org` link admits signed-in members of the organization and may be created by anyone who can view the artifact; a `public` link admits anyone who has it and may be created by the artifact’s owner, or by an organization owner who can view it. The response carries the link token and the console path `/share/<token>` exactly once; only a hash of the token is stored. The share stays on this revision when a newer one is published. 403 `ARTIFACT_SHARE_FORBIDDEN` when the caller can view the artifact but may not create this audience; 404 when they cannot view it or the revision does not exist; 409 `ARTIFACT_REVISION_NOT_READY` while the revision is still uploading.',
          operationId: 'createArtifactShare',
          params: ArtifactParams,
          body: CreateArtifactShareBody,
          response: { 201: CreatedArtifactShareDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await managed(req, req.params.artifactId)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, viewer, canView } = found
        const action = req.body.audience === 'public' ? ArtifactAction.SharePublic : ArtifactAction.ShareOrg
        if (!canActOnArtifact(action, artifact, viewer)) return refuse(reply, canView)
        const revision = await deps.repos.artifact.getRevision(orgOf(req), artifact.id, req.body.revision)
        if (!revision)
          return reply.code(404).send({ error: 'Not Found', statusCode: 404, message: 'revision not found' })
        if (revision.state !== 'ready') {
          return reply.code(409).send({
            error: 'Conflict',
            statusCode: 409,
            code: 'ARTIFACT_REVISION_NOT_READY',
            message: 'this revision is still uploading'
          })
        }
        const created = await deps.artifactShares.create({
          orgId: orgOf(req),
          artifactId: artifact.id,
          revisionNumber: revision.number,
          audience: req.body.audience,
          createdByIdentity: `user:${ctxOf(req).userId}`
        })
        return reply.code(201).send({
          ...(await shareDto(req, created.share)),
          token: created.token,
          linkPath: created.linkPath,
          link: created.link ?? null
        })
      }
    )

    r.get(
      '/artifacts/:artifactId/shares',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'List an artifact’s shares',
          description:
            'The artifact’s active share links, newest first, each with its revision, audience, the tail of its token and who created it; never the token itself. Open to whoever can view the artifact, and to its owner and organization owners, who can revoke a share without viewing the artifact. Anyone else gets 404.',
          operationId: 'listArtifactShares',
          params: ArtifactParams,
          response: { 200: ArtifactShareListDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await managed(req, req.params.artifactId)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, viewer, canView } = found
        if (!canView && !canActOnArtifact(ArtifactAction.RevokeShare, artifact, viewer)) {
          return reply.code(404).send(notFound)
        }
        const members: Members = new Map()
        const shares = await deps.artifactShares.listActive(orgOf(req), artifact.id)
        return { shares: await Promise.all(shares.map((share) => shareDto(req, share, members))) }
      }
    )

    r.patch(
      '/artifacts/:artifactId/shares/:shareId',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Change a share’s audience',
          description:
            'Moves an active share between `public` and `org`; the link stays the same. Only the artifact’s owner, or an organization owner who can view it, may do this. 403 `ARTIFACT_SHARE_FORBIDDEN` for anyone else who can view the artifact; 404 when the caller cannot view it, or the share does not exist or is revoked.',
          operationId: 'updateArtifactShare',
          params: ArtifactShareParams,
          body: UpdateArtifactShareBody,
          response: { 200: ArtifactShareDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await managed(req, req.params.artifactId)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, viewer, canView } = found
        if (!canActOnArtifact(ArtifactAction.SharePublic, artifact, viewer)) return refuse(reply, canView)
        const share = await deps.artifactShares.setAudience(
          orgOf(req),
          artifact.id,
          req.params.shareId,
          req.body.audience
        )
        if (!share) return reply.code(404).send(shareNotFound)
        return shareDto(req, share)
      }
    )

    r.delete(
      '/artifacts/:artifactId/shares/:shareId',
      {
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Revoke a share',
          description:
            'Revokes a share link; the next read of the link answers 410 `ARTIFACT_SHARE_REVOKED`. The artifact’s owner and organization owners may revoke, including an organization owner who cannot view the artifact, and so may the member who created the share. Revoking a revoked share succeeds again. 403 `ARTIFACT_SHARE_FORBIDDEN` for anyone else who can view the artifact; 404 when the caller cannot view it or the share does not exist.',
          operationId: 'revokeArtifactShare',
          params: ArtifactShareParams,
          response: { 204: z.null(), 403: ErrorDto, 404: ErrorDto, 409: ErrorDto }
        }
      },
      async (req, reply) => {
        if (!deps.artifacts) return reply.code(409).send(notEnabled)
        const found = await managed(req, req.params.artifactId)
        if (!found) return reply.code(404).send(notFound)
        const { artifact, viewer, canView } = found
        const share = await deps.artifactShares.get(orgOf(req), artifact.id, req.params.shareId)
        // Someone who can neither view nor manage the artifact learns nothing about it, not even that a share is missing.
        if (!share) {
          const manages = canView || canActOnArtifact(ArtifactAction.RevokeShare, artifact, viewer)
          return reply.code(404).send(manages ? shareNotFound : notFound)
        }
        if (!canRevokeArtifactShare(artifact, share, viewer)) return refuse(reply, canView)
        const revoked = await deps.artifactShares.revoke(orgOf(req), artifact.id, share.id)
        if (!revoked) return reply.code(404).send(shareNotFound)
        return reply.code(204).send(null)
      }
    )
  }
}

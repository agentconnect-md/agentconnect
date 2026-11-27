// Share-link reads (artifacts.md §8.3), outside `/orgs/:orgId` because a `public` link admits people who are no member.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from '../plugins/zod.js'
import type { HttpDeps } from '../deps.js'
import { Tag } from '../plugins/openapi.js'
import { refuseWithoutOrgSso } from '../org-scope.js'
import type { ArtifactRevisionRecord, ArtifactShareRecord } from '../../persistence/ports.js'
import {
  ArtifactFileUrlDto,
  ErrorDto,
  SharedArtifactBody,
  SharedArtifactDto,
  SharedArtifactFileBody
} from '../dto/index.js'

const notEnabled = {
  error: 'Conflict',
  statusCode: 409,
  code: 'ARTIFACTS_NOT_ENABLED',
  message: 'artifacts are not enabled on this deployment'
}
const notFound = {
  error: 'Not Found',
  statusCode: 404,
  code: 'ARTIFACT_SHARE_NOT_FOUND',
  message: 'this link does not exist'
}
const revoked = {
  error: 'Gone',
  statusCode: 410,
  code: 'ARTIFACT_SHARE_REVOKED',
  message: 'this link has been revoked'
}
// Only someone already holding the token learns that it is an `org` link they are not a member for.
const membersOnly = {
  error: 'Not Found',
  statusCode: 404,
  code: 'ARTIFACT_SHARE_MEMBERS_ONLY',
  message: 'this link is open to members of its organization only'
}

const READ_ROUTE_RESPONSES = { 401: ErrorDto, 403: ErrorDto, 404: ErrorDto, 409: ErrorDto, 410: ErrorDto }

export function artifactShareReadRoutes(deps: HttpDeps) {
  return async function artifactShareReadRoutesPlugin(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>()
    const authenticate = app.humanAuth as (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>

    // Every answer, errors included: never indexed, never cached past a revocation.
    app.addHook('onSend', async (_req, reply, payload) => {
      void reply.header('x-robots-tag', 'noindex').header('cache-control', 'no-store')
      return payload
    })

    /** An `org` link admits a signed-in member of the artifact's organization, as the `/orgs/:orgId` guard would; false once it replied. */
    const admitMember = async (req: FastifyRequest, reply: FastifyReply, orgId: string): Promise<boolean> => {
      await authenticate(req, reply)
      if (reply.sent) return false
      if (!req.principal) {
        void reply.code(401).send({ error: 'Unauthorized', statusCode: 401, message: 'sign in to open this link' })
        return false
      }
      // A key bound to another organization reaches nothing here, as under `/orgs/:orgId`.
      const role =
        req.apiKeyOrgId && req.apiKeyOrgId !== orgId ? null : await deps.repos.org.roleOf(orgId, req.principal.userId)
      if (!role) {
        void reply.code(404).send(membersOnly)
        return false
      }
      return !(await refuseWithoutOrgSso(deps.orgSsoSession, req, reply, orgId))
    }

    /** The active share a token names and its pinned ready revision, once the caller is admitted; null once it replied. */
    const open = async (
      req: FastifyRequest,
      reply: FastifyReply,
      token: string
    ): Promise<{ share: ArtifactShareRecord; title: string; revision: ArtifactRevisionRecord } | null> => {
      if (!deps.artifacts) {
        void reply.code(409).send(notEnabled)
        return null
      }
      const resolved = await deps.artifactShares.resolve(token)
      if (!resolved) {
        void reply.code(404).send(notFound)
        return null
      }
      const { share, artifact } = resolved
      if (share.revokedAt) {
        void reply.code(410).send(revoked)
        return null
      }
      // A `public` link never reads the caller's credentials, so a missing or stale bearer cannot refuse it.
      if (share.audience === 'org' && !(await admitMember(req, reply, share.orgId))) return null
      const revision = await deps.repos.artifact.getRevision(share.orgId, share.artifactId, share.revisionNumber)
      if (revision?.state !== 'ready') {
        void reply.code(404).send(notFound)
        return null
      }
      return { share, title: artifact.title, revision }
    }

    r.post(
      '/artifact-shares/read',
      {
        // A read-only credential may open an `org` link; the POST only keeps the token out of the URL.
        config: { permission: 'read' },
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Open a shared artifact',
          description:
            'What a share link shows: the artifact’s title, the source organization’s display name and the pinned revision with its manifest; never the session, the owner or the conversation, and nothing about newer revisions. The token travels in the body to keep it out of URLs. A `public` link needs no credentials. An `org` link needs a signed-in member of the artifact’s organization: 401 without sign-in, 404 `ARTIFACT_SHARE_MEMBERS_ONLY` for anyone else. 404 `ARTIFACT_SHARE_NOT_FOUND` for an unknown token or a revision that is gone; 410 `ARTIFACT_SHARE_REVOKED` once revoked; 409 `ARTIFACTS_NOT_ENABLED` on a deployment without artifacts. Every response carries `X-Robots-Tag: noindex` and `Cache-Control: no-store`.',
          operationId: 'readSharedArtifact',
          body: SharedArtifactBody,
          response: { 200: SharedArtifactDto, ...READ_ROUTE_RESPONSES }
        }
      },
      async (req, reply) => {
        const opened = await open(req, reply, req.body.token)
        if (!opened) return reply
        const { share, title, revision } = opened
        const organization = await deps.repos.org.displayNameById(share.orgId)
        if (organization === null) return reply.code(404).send(notFound)
        const entry = revision.manifest.files.find((f) => f.path === revision.manifest.entry)
        return {
          artifactId: share.artifactId,
          title,
          audience: share.audience,
          organization: { name: organization },
          sharedAt: share.createdAt.toISOString(),
          revision: {
            number: revision.number,
            entry: revision.manifest.entry,
            entryMediaType: entry?.mediaType ?? 'application/octet-stream',
            fileCount: revision.fileCount,
            totalBytes: revision.totalBytes,
            createdAt: revision.createdAt.toISOString(),
            manifest: revision.manifest
          }
        }
      }
    )

    r.post(
      '/artifact-shares/file',
      {
        config: { permission: 'read' },
        schema: {
          tags: [Tag.Artifacts],
          summary: 'Get a signed download for a shared artifact file',
          description:
            'A short-lived signed URL for one file of the shared revision, named by its manifest path, served by the object store as an `application/octet-stream` attachment exactly as `getArtifactFileUrl`. Admission and status codes are those of `readSharedArtifact`; 404 `ARTIFACT_SHARE_NOT_FOUND` also when the path is not in the manifest.',
          operationId: 'getSharedArtifactFileUrl',
          body: SharedArtifactFileBody,
          response: { 200: ArtifactFileUrlDto, ...READ_ROUTE_RESPONSES }
        }
      },
      async (req, reply) => {
        const opened = await open(req, reply, req.body.token)
        if (!opened) return reply
        const file = opened.revision.manifest.files.find((f) => f.path === req.body.path)
        const get = file ? await deps.artifacts!.fileDownload(opened.revision, file.path) : null
        if (!file || !get) return reply.code(404).send(notFound)
        return { ...file, url: get.url, expiresAt: new Date(get.expiresAt).toISOString() }
      }
    )
  }
}

// Artifacts over the wire (artifacts.md §5.3, §6.1, §7.2): the CP authorizes, records and signs; bytes go daemon → bucket.
import type {
  ArtifactAudienceSummary,
  ArtifactFetchOk,
  ArtifactFetchReq,
  ArtifactInitiator as WireInitiator,
  ArtifactListEntry,
  ArtifactListOk,
  ArtifactListReq,
  ArtifactPublishBeginOk,
  ArtifactPublishBeginReq,
  ArtifactPublishCompleteReq,
  ArtifactPublished,
  ArtifactRefusalReason,
  ErrorCode
} from '@agentconnect.md/protocol'
import { ARTIFACT_LIST_PAGE_MAX } from '@agentconnect.md/protocol'
import {
  agentCanReachArtifact,
  artifactAudienceFromSession,
  type ArtifactAudience,
  type ArtifactInitiator,
  type ArtifactReachSession,
  type ArtifactViewer
} from '../authorization/artifact-policy.js'
import { canEdit } from '../authorization/policy.js'
import { AgentId, CronId, HookId, OrgId, SessionId } from '../domain/ids.js'
import {
  artifactObjectKey,
  artifactRevisionPrefix,
  FileTransferError,
  type FileTransfer,
  type TransferUrl
} from '../file-transfer/transfer.js'
import type { ReadAccessResolver } from '../orchestrator/readAccess.js'
import {
  ArtifactIdempotencyConflictError,
  decodeArtifactCursor,
  encodeArtifactCursor
} from '../persistence/repositories/artifact.repo.js'
import type {
  AgentRecord,
  AgentRepo,
  ArtifactManifest,
  ArtifactRecord,
  ArtifactRepo,
  ArtifactRevisionRecord,
  CronRepo,
  HookRepo,
  OrgRepo,
  SessionMetaRecord,
  SessionRepo,
  UserRepo
} from '../persistence/ports.js'

/** HEADs one complete runs at once. */
const HEAD_CONCURRENCY = 16

/** A refusal the WS handler answers as an error frame whose `details.reason` names the rule. */
export class ArtifactRefusal extends Error {
  constructor(
    readonly reason: ArtifactRefusalReason,
    readonly code: Extract<ErrorCode, 'SCOPE_DENIED' | 'CONFLICT' | 'BAD_PAYLOAD'>,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'ArtifactRefusal'
  }
}

const notFound = () =>
  new ArtifactRefusal('not-found', 'SCOPE_DENIED', 'no such artifact or revision is reachable from this session')

export interface ArtifactServiceDeps {
  transfer?: FileTransfer
  artifacts: ArtifactRepo
  sessions: Pick<SessionRepo, 'get'>
  users: Pick<UserRepo, 'activeMember'>
  agents: Pick<AgentRepo, 'get'>
  crons: Pick<CronRepo, 'listForAgent'>
  hooks: Pick<HookRepo, 'get'>
  orgs: Pick<OrgRepo, 'slugById'>
  /** Resolves a chat member to the console member who linked it; absent leaves every chat initiator a non-member. */
  readAccess?: ReadAccessResolver
  /** The console's origin, for absolute links. */
  webAppUrl?: string
  log?: { warn(obj: unknown, msg: string): void }
}

export interface ArtifactService {
  /** `artifact/publish/begin`; the caller has checked that the daemon serves `agent`. */
  begin(orgId: string, agent: AgentRecord, req: ArtifactPublishBeginReq): Promise<ArtifactPublishBeginOk>
  /** `artifact/publish/complete`; HEADs every object before the revision becomes ready. */
  complete(orgId: string, req: ArtifactPublishCompleteReq): Promise<ArtifactPublished>
  /** `artifact/fetch`: GETs for a ready revision the session reaches. */
  fetch(orgId: string, req: ArtifactFetchReq): Promise<ArtifactFetchOk>
  /** `artifact/list`: a page of what the session reaches. */
  list(orgId: string, req: ArtifactListReq): Promise<ArtifactListOk>
  /** A browser GET for one file of a ready revision, downloaded as an attachment; undefined without a bucket. */
  fileDownload(revision: ArtifactRevisionRecord, path: string): Promise<TransferUrl | undefined>
}

const hexToBase64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64')
const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** The manifest's canonical JSON, so a replayed key can be compared with what it recorded. */
const canonicalManifest = (manifest: ArtifactManifest): string =>
  JSON.stringify({
    entry: manifest.entry,
    files: manifest.files.map((f) => [f.path, f.sha256, f.bytes, f.mediaType])
  })

export function audienceSummary(artifact: ArtifactAudience): ArtifactAudienceSummary {
  return {
    visibility: artifact.visibility,
    ...(artifact.visibility === 'external' && artifact.externalProvider
      ? { externalProvider: artifact.externalProvider }
      : {}),
    owned: artifact.ownerIdentity !== null
  }
}

function reachSessionOf(session: SessionMetaRecord): ArtifactReachSession {
  return {
    orgId: session.orgId,
    agentId: session.agentId,
    visibility: session.visibility,
    externalProvider: session.externalProvider,
    externalScopeId: session.externalScopeId,
    externalResolution: session.externalResolution
  }
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const at = next++
      out[at] = await fn(items[at] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function decodeCursor(cursor: string | undefined): { updatedAt: Date; id: string } | undefined {
  if (!cursor) return undefined
  const decoded = decodeArtifactCursor(cursor)
  if (!decoded)
    throw new ArtifactRefusal('not-found', 'BAD_PAYLOAD', 'the list cursor is not one this control plane issued')
  return decoded
}

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  const { transfer, artifacts } = deps

  const requireTransfer = (): FileTransfer => {
    if (!transfer)
      throw new ArtifactRefusal('transfer-unavailable', 'SCOPE_DENIED', 'this deployment has no bucket for artifacts')
    if (!transfer.enabled())
      throw new ArtifactRefusal('transfer-unavailable', 'SCOPE_DENIED', 'the transfer bucket is unavailable', true)
    return transfer
  }

  const refusalOf = (err: unknown): unknown =>
    err instanceof FileTransferError
      ? err.reason === 'too-large'
        ? new ArtifactRefusal('too-large', 'BAD_PAYLOAD', err.message)
        : new ArtifactRefusal(
            'transfer-unavailable',
            'SCOPE_DENIED',
            err.message,
            err.reason === 'transfer-unavailable'
          )
      : err

  /** The agent's own session whose content is still held; an unreported one may still be on its way. */
  const agentSession = async (orgId: string, agentId: string, sessionId: string): Promise<SessionMetaRecord> => {
    const session = await deps.sessions.get(OrgId(orgId), SessionId(sessionId))
    if (!session)
      throw new ArtifactRefusal(
        'session-unknown',
        'SCOPE_DENIED',
        'the control plane does not know this session yet',
        true
      )
    if (session.agentId !== agentId)
      throw new ArtifactRefusal('session-denied', 'SCOPE_DENIED', 'the session is not this agent’s')
    if (session.contentPurgedAt)
      throw new ArtifactRefusal('session-denied', 'SCOPE_DENIED', 'the session’s content was deleted')
    return session
  }

  /** A private session's owner as a member (§7.2); only a `user:` owner is resolved here, a platform identity reaches nothing. */
  const sessionOwner = async (
    session: SessionMetaRecord,
    editorsAgentIds: readonly string[]
  ): Promise<ArtifactViewer | undefined> => {
    const owner = session.ownerIdentity
    if (session.visibility !== 'private' || !owner?.startsWith('user:')) return undefined
    const userId = owner.slice('user:'.length)
    const member = await deps.users.activeMember(session.orgId, userId)
    if (!member) return undefined
    const principal = { userId, role: member.role }
    const agents = await Promise.all(
      [...new Set(editorsAgentIds)].map((id) => deps.agents.get(OrgId(session.orgId), AgentId(id)))
    )
    const editableAgentIds = new Set(agents.flatMap((a) => (a && canEdit(a, principal) ? [a.id as string] : [])))
    return { orgId: session.orgId, principal, identitySet: new Set([owner]), editableAgentIds }
  }

  const reaches = async (artifact: ArtifactRecord, session: SessionMetaRecord): Promise<boolean> => {
    const owner = await sessionOwner(session, artifact.editorsAgentId ? [artifact.editorsAgentId] : [])
    return agentCanReachArtifact(artifact, reachSessionOf(session), owner)
  }

  /** Who started the turn, as §6.1 needs it, and the identity the revision records as its initiator. */
  const initiatorOf = async (
    orgId: string,
    agentId: string,
    initiator: WireInitiator | undefined
  ): Promise<{ initiator: ArtifactInitiator; initiatedBy: string | null }> => {
    const nonMember = { initiator: { kind: 'nonMember' } as const, initiatedBy: null }
    switch (initiator?.kind) {
      case undefined:
        return nonMember
      case 'console': {
        const member = await deps.users.activeMember(orgId, initiator.userId)
        return member
          ? { initiator: { kind: 'member', userId: member.userId }, initiatedBy: `user:${member.userId}` }
          : nonMember
      }
      case 'chat': {
        if (!deps.readAccess) return nonMember
        try {
          const answer = await deps.readAccess(
            {
              agentId,
              asker: { integrationId: initiator.integrationId, memberId: initiator.memberId },
              sessionIds: []
            },
            orgId
          )
          return answer.asker === 'linked' && answer.consoleUserId
            ? {
                initiator: { kind: 'member', userId: answer.consoleUserId },
                initiatedBy: `user:${answer.consoleUserId}`
              }
            : nonMember
        } catch (err) {
          // An identity lookup that fails gives no owner rather than failing the publish.
          deps.log?.warn({ err, agentId }, 'artifact initiator lookup failed')
          return nonMember
        }
      }
      case 'cron': {
        const cron = (await deps.crons.listForAgent(AgentId(agentId))).find(
          (c) => c.id === CronId(initiator.cronId) && c.orgId === orgId
        )
        // An unknown trigger has no conversation to copy and no creator: organization owners only.
        const trigger = cron
          ? { createdByUserId: cron.createdByUserId, headless: cron.targetChannel === null }
          : { createdByUserId: null, headless: true }
        return { initiator: { kind: 'trigger', ...trigger }, initiatedBy: `cron:${initiator.cronId}` }
      }
      case 'hook': {
        const hook = await deps.hooks.get(OrgId(orgId), HookId(initiator.hookId))
        const trigger =
          hook && hook.agentId === agentId
            ? { createdByUserId: hook.createdByUserId, headless: hook.targetChannel === null }
            : { createdByUserId: null, headless: true }
        return { initiator: { kind: 'trigger', ...trigger }, initiatedBy: `hook:${initiator.hookId}` }
      }
    }
  }

  const published = async (artifact: ArtifactRecord, revision: number): Promise<ArtifactPublished> => {
    const slug = (await deps.orgs.slugById(artifact.orgId)) ?? artifact.orgId
    const linkPath = `/${encodeURIComponent(slug)}/artifacts/${artifact.id}?revision=${revision}`
    const base = deps.webAppUrl?.replace(/\/+$/, '')
    return {
      artifactId: artifact.id,
      revision,
      title: artifact.title,
      linkPath,
      ...(base ? { link: `${base}${linkPath}` } : {}),
      audience: audienceSummary(artifact)
    }
  }

  return {
    async begin(orgId, agent, req) {
      const bucket = requireTransfer()
      const oversized = req.manifest.files.find((file) => file.bytes > bucket.maxBytes)
      if (oversized) {
        throw new ArtifactRefusal(
          'too-large',
          'BAD_PAYLOAD',
          `\`${oversized.path}\` exceeds the transfer limit of ${bucket.maxBytes} bytes`
        )
      }
      const session = await agentSession(orgId, agent.id, req.sessionId)
      const { initiator, initiatedBy } = await initiatorOf(orgId, agent.id, req.initiator)
      const revision = {
        manifest: req.manifest,
        storageMode: 'signed' as const,
        storagePrefix: ({ artifactId, number }: { artifactId: string; number: number }) =>
          artifactRevisionPrefix(orgId, artifactId, number),
        producedByAgentId: agent.id,
        producedByAgentName: agent.displayName ?? agent.name,
        producedInSessionId: req.sessionId,
        initiatedBy,
        idempotencyKey: req.idempotencyKey
      }

      let result
      try {
        if (req.artifactId === undefined) {
          if (req.title === undefined)
            throw new ArtifactRefusal('title-required', 'BAD_PAYLOAD', 'a new artifact needs a title')
          const audience = artifactAudienceFromSession(
            { ...reachSessionOf(session), ownerIdentity: session.ownerIdentity },
            initiator
          )
          result = await artifacts.create({ ...audience, title: req.title, originSessionId: req.sessionId }, revision)
        } else {
          // Reach first, so an artifact the session may not see reads as absent rather than as someone else's.
          const artifact = await artifacts.get(orgId, req.artifactId)
          if (!artifact || !(await reaches(artifact, session))) throw notFound()
          const first = await artifacts.getRevision(orgId, artifact.id, 1)
          if (first?.producedByAgentId !== agent.id) {
            throw new ArtifactRefusal('not-producer', 'SCOPE_DENIED', 'an agent revises only the artifacts it produced')
          }
          result = await artifacts.appendRevision(orgId, artifact.id, revision)
          if (!result) throw notFound()
        }
      } catch (err) {
        if (err instanceof ArtifactIdempotencyConflictError) {
          throw new ArtifactRefusal('idempotency-conflict', 'CONFLICT', err.message)
        }
        throw err
      }

      if (result.replayed) {
        if (canonicalManifest(result.revision.manifest) !== canonicalManifest(req.manifest)) {
          throw new ArtifactRefusal('idempotency-conflict', 'CONFLICT', 'the idempotency key recorded another manifest')
        }
        if (result.revision.state === 'ready') {
          return { state: 'ready', ...(await published(result.artifact, result.revision.number)) }
        }
      }
      const { storagePrefix, artifactId, number } = result.revision
      try {
        const uploads = await Promise.all(
          req.manifest.files.map(async (file) => {
            const put = await bucket.signPut({
              key: artifactObjectKey(storagePrefix, file.path),
              bytes: file.bytes,
              sha256: hexToBase64(file.sha256),
              network: req.network,
              retain: true
            })
            return { path: file.path, url: put.url, headers: put.headers, expiresAt: put.expiresAt }
          })
        )
        return {
          state: 'pending',
          artifactId,
          revision: number,
          uploads: uploads.map(({ path, url, headers }) => ({ path, url, headers })),
          expiresAt: Math.min(...uploads.map((u) => u.expiresAt))
        }
      } catch (err) {
        throw refusalOf(err)
      }
    },

    async complete(orgId, req) {
      const bucket = requireTransfer()
      const revision = await artifacts.getRevision(orgId, req.artifactId, req.revision)
      if (!revision || revision.producedByAgentId !== req.agentId) throw notFound()
      if (revision.state !== 'ready') {
        const missing = (
          await mapLimited(revision.manifest.files, HEAD_CONCURRENCY, async (file) =>
            (await bucket.holds({
              key: artifactObjectKey(revision.storagePrefix, file.path),
              size: file.bytes,
              sha256: hexToBase64(file.sha256)
            }))
              ? null
              : file.path
          ).catch((err: unknown) => {
            throw refusalOf(err)
          })
        ).filter((path): path is string => path !== null)
        if (missing.length > 0) {
          throw new ArtifactRefusal(
            'incomplete',
            'CONFLICT',
            `${missing.length} file(s) are missing or differ from the manifest`,
            false,
            { paths: missing.slice(0, 20) }
          )
        }
      }
      const artifact = await artifacts.markReady(orgId, req.artifactId, req.revision)
      if (!artifact) throw notFound()
      return await published(artifact, req.revision)
    },

    async fetch(orgId, req) {
      const bucket = requireTransfer()
      const session = await agentSession(orgId, req.agentId, req.sessionId)
      const artifact = await artifacts.get(orgId, req.artifactId)
      if (!artifact || artifact.latestRevision === 0 || !(await reaches(artifact, session))) throw notFound()
      const revision = await artifacts.getRevision(orgId, artifact.id, req.revision ?? artifact.latestRevision)
      if (!revision || revision.state !== 'ready') throw notFound()
      try {
        const gets = await Promise.all(
          revision.manifest.files.map(async (file) => ({
            path: file.path,
            get: await bucket.signGet({
              key: artifactObjectKey(revision.storagePrefix, file.path),
              network: req.network
            })
          }))
        )
        return {
          artifactId: artifact.id,
          revision: revision.number,
          title: artifact.title,
          manifest: revision.manifest,
          downloads: gets.map(({ path, get }) => ({ path, url: get.url })),
          expiresAt: Math.min(...gets.map(({ get }) => get.expiresAt))
        }
      } catch (err) {
        throw refusalOf(err)
      }
    },

    async list(orgId, req) {
      const session = await agentSession(orgId, req.agentId, req.sessionId)
      const cursor = decodeCursor(req.cursor)
      // A private session's `editors` reach is listed for the session's own agent; fetch checks any agent exactly.
      const owner = await sessionOwner(session, [session.agentId])
      const rows = await artifacts.listReachable(reachSessionOf(session), owner, {
        limit: ARTIFACT_LIST_PAGE_MAX + 1,
        ...(cursor ? { cursor } : {})
      })
      const page = rows.slice(0, ARTIFACT_LIST_PAGE_MAX)
      const entries = await mapLimited(page, HEAD_CONCURRENCY, async (row): Promise<ArtifactListEntry | null> => {
        const latest = await artifacts.getRevision(orgId, row.id, row.latestRevision)
        const first = row.latestRevision === 1 ? latest : await artifacts.getRevision(orgId, row.id, 1)
        if (!latest) return null
        const entry = latest.manifest.files.find((f) => f.path === latest.manifest.entry)
        return {
          artifactId: row.id,
          title: row.title,
          audience: audienceSummary(row),
          producedByAgent: first?.producedByAgentId === req.agentId,
          updatedAt: row.updatedAt.toISOString(),
          latest: {
            revision: latest.number,
            entry: latest.manifest.entry,
            entryMediaType: entry?.mediaType ?? 'application/octet-stream',
            fileCount: latest.fileCount,
            totalBytes: latest.totalBytes,
            producedByAgentName: latest.producedByAgentName,
            createdAt: latest.createdAt.toISOString()
          }
        }
      })
      const last = page.at(-1)
      return {
        artifacts: entries.filter((e): e is ArtifactListEntry => e !== null),
        ...(rows.length > ARTIFACT_LIST_PAGE_MAX && last ? { nextCursor: encodeArtifactCursor(last) } : {})
      }
    },

    async fileDownload(revision, path) {
      if (!transfer || !revision.manifest.files.some((f) => f.path === path)) return undefined
      return await transfer.signDownload({ key: artifactObjectKey(revision.storagePrefix, path), name: basename(path) })
    }
  }
}

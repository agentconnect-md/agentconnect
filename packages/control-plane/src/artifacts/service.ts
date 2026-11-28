// Artifacts over the wire (artifacts.md §5.3, §6.1, §7.2): the CP authorizes, records and signs; bytes go daemon → bucket.
import type {
  ArtifactAudienceSummary,
  ArtifactDeleteOk,
  ArtifactDeleteReq,
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
  ArtifactShareOk,
  ArtifactShareReq,
  ArtifactStaleBase,
  ArtifactUnshareOk,
  ArtifactUnshareReq,
  ErrorCode
} from '@agentconnect.md/protocol'
import {
  ARTIFACT_LIST_PAGE_MAX,
  ARTIFACT_LIST_SHARES_MAX,
  artifactRevisionLimitProblem,
  formatArtifactBytes
} from '@agentconnect.md/protocol'
import { SOURCE_CACHE_GRACE_SECONDS } from '@agentconnect.md/object-store'
import {
  agentCanReachArtifact,
  ArtifactAction,
  artifactAudienceFromSession,
  canActOnArtifact,
  canRevokeArtifactShare,
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
  isTransferObjectKey,
  type FileTransfer,
  type TransferUrl
} from '../file-transfer/transfer.js'
import type { ReadAccessResolver } from '../orchestrator/readAccess.js'
import type { ArtifactShareService } from './shares.js'
import { revisionExpired, unfinishedRevisionExpired } from './retention.js'
import { manifestChanges } from './stale-base.js'
import {
  ArtifactIdempotencyConflictError,
  ArtifactOrgLimitError,
  ArtifactStaleBaseError,
  decodeArtifactCursor,
  encodeArtifactCursor
} from '../persistence/repositories/artifact.repo.js'
import type {
  AgentRecord,
  AgentRepo,
  ArtifactDeletionRecord,
  ArtifactManifest,
  ArtifactRecord,
  ArtifactRepo,
  ArtifactRevisionRecord,
  CronRepo,
  HookRepo,
  OrgRepo,
  SessionMetaRecord,
  SessionRepo,
  UserRepo,
  ViewCtx
} from '../persistence/ports.js'

/** HEADs one complete runs at once. */
const HEAD_CONCURRENCY = 16
/** Object DELETEs one sweep runs at once. */
const DELETE_CONCURRENCY = 16
/** Deletions one reaper pass sweeps. */
const REAP_BATCH = 50
/** Expired revisions one retention pass removes. */
export const PRUNE_BATCH = 100
/** Unfinished revisions one cleanup pass removes. */
export const UNFINISHED_BATCH = 100
/** The longest upload URL the transfer config admits, for a service built without its own value. */
const MAX_UPLOAD_URL_SECONDS = 3600

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
const shareNotFound = () => new ArtifactRefusal('share-not-found', 'SCOPE_DENIED', 'no such share on this artifact')

/** A member's identities and provider decisions for one artifact, as the console resolves them for that member. */
export type ArtifactMemberAccess = (
  orgId: string,
  principal: ViewCtx,
  artifact: ArtifactAudience
) => Promise<Pick<ArtifactViewer, 'identitySet' | 'externalAccess' | 'editableAgentIds'>>

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
  /** Share links; absent refuses `artifact/share|unshare` as not enabled and lists no shares. */
  shares?: ArtifactShareService
  /** Absent gives a member only their `user:` identity, no `external` access, and edit rights read here. */
  memberAccess?: ArtifactMemberAccess
  /** The organization's artifact total in bytes, null for none; absent sets no total (artifacts.md §10.2). */
  orgBytesLimit?: (orgId: string) => Promise<number | null>
  /** The console's origin, for absolute links. */
  webAppUrl?: string
  /** The PUT lifetime the bucket signs (`limits.putUrlSeconds`); a deletion sweeps once more after it. */
  uploadUrlSeconds?: number
  now?: () => number
  log?: { warn(obj: unknown, msg: string): void }
}

export interface ArtifactService {
  /** `artifact/publish/begin` from `daemonId`, whose retention ages the revision; the caller has checked that it serves `agent`. */
  begin(
    orgId: string,
    agent: AgentRecord,
    req: ArtifactPublishBeginReq,
    daemonId?: string
  ): Promise<ArtifactPublishBeginOk>
  /** `artifact/publish/complete`; HEADs every object before the revision becomes ready. */
  complete(orgId: string, req: ArtifactPublishCompleteReq): Promise<ArtifactPublished>
  /** `artifact/fetch`: GETs for a ready revision the session reaches. */
  fetch(orgId: string, req: ArtifactFetchReq): Promise<ArtifactFetchOk>
  /** `artifact/list`: a page of what the session reaches. */
  list(orgId: string, req: ArtifactListReq): Promise<ArtifactListOk>
  /** `artifact/share`: a share link to a ready revision, with the turn member's §6.3 authority (§7.3). */
  share(orgId: string, req: ArtifactShareReq): Promise<ArtifactShareOk>
  /** `artifact/unshare`: revoke one share, with the turn member's §6.3 authority (§7.3). */
  unshare(orgId: string, req: ArtifactUnshareReq): Promise<ArtifactUnshareOk>
  /** `artifact/delete`: delete an artifact this agent produced, with the turn member's §6.3 authority (§7.3). */
  delete(orgId: string, req: ArtifactDeleteReq): Promise<ArtifactDeleteOk>
  /** Delete the artifact's rows at once and then its objects (§10.1); the caller has checked §6.3. Null when it is gone. */
  deleteArtifact(orgId: string, artifactId: string): Promise<{ deletedAt: Date } | null>
  /** Sweep the objects of deletions due now, dropping each record after its last sweep; returns how many were dropped. */
  reap(): Promise<number>
  /** Remove up to `PRUNE_BATCH` revisions past their installation's retention, objects right after (§10.1); returns how many. */
  prune(): Promise<number>
  /** Remove up to `UNFINISHED_BATCH` pending or closed revisions whose PUTs have expired plus the grace (§10.1); returns how many. */
  removeUnfinished(): Promise<number>
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
  const now = deps.now ?? Date.now
  const purgeDelayMs = ((deps.uploadUrlSeconds ?? MAX_UPLOAD_URL_SECONDS) + SOURCE_CACHE_GRACE_SECONDS) * 1000

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

  const requireShares = (): ArtifactShareService => {
    if (!deps.shares)
      throw new ArtifactRefusal('not-enabled', 'SCOPE_DENIED', 'this deployment does not offer artifact share links')
    return deps.shares
  }

  /** §7.2 for a change: an artifact the session reaches and whose revision 1 this agent produced. */
  const ownArtifact = async (
    orgId: string,
    agentId: string,
    artifactId: string,
    session: SessionMetaRecord,
    verb = 'shares'
  ): Promise<ArtifactRecord> => {
    const artifact = await artifacts.get(orgId, artifactId)
    if (!artifact || artifact.latestRevision === 0 || !(await reaches(artifact, session))) throw notFound()
    const first = await artifacts.getRevision(orgId, artifact.id, 1)
    if (first?.producedByAgentId !== agentId)
      throw new ArtifactRefusal('not-producer', 'SCOPE_DENIED', `an agent ${verb} only the artifacts it produced`)
    return artifact
  }

  /** §7.3: the initiator, or a trigger's creator, as a viewer of `artifact` — only while they are an organization member. */
  const memberAuthority = async (
    orgId: string,
    agentId: string,
    initiator: WireInitiator | undefined,
    artifact: ArtifactRecord
  ): Promise<ArtifactViewer> => {
    const { initiator: resolved } = await initiatorOf(orgId, agentId, initiator)
    const userId =
      resolved.kind === 'member' ? resolved.userId : resolved.kind === 'trigger' ? resolved.createdByUserId : null
    const member = userId ? await deps.users.activeMember(orgId, userId) : null
    if (!userId || !member) {
      throw new ArtifactRefusal(
        'no-member-authority',
        'SCOPE_DENIED',
        'only a turn started by an organization member, or a trigger a member set up, may share, unshare or delete'
      )
    }
    const principal = { userId, role: member.role }
    if (deps.memberAccess) return { orgId, principal, ...(await deps.memberAccess(orgId, principal, artifact)) }
    const editors = artifact.editorsAgentId
      ? await deps.agents.get(OrgId(orgId), AgentId(artifact.editorsAgentId))
      : null
    const editableAgentIds = new Set(editors && canEdit(editors, principal) ? [editors.id as string] : [])
    return { orgId, principal, identitySet: new Set([`user:${userId}`]), editableAgentIds }
  }

  /** Delete every key, then drop the record if this sweep began after `purgeAfter`, else mark it swept; throws on a failed delete. */
  const sweep = async (bucket: FileTransfer, deletion: ArtifactDeletionRecord): Promise<boolean> => {
    const startedAt = now()
    // Keys were built from validated prefixes and manifest paths; anything else is skipped rather than sent.
    const keys = deletion.objectKeys.filter(isTransferObjectKey)
    await mapLimited(keys, DELETE_CONCURRENCY, (key) => bucket.deleteObject(key))
    if (startedAt >= deletion.purgeAfter.getTime()) {
      await artifacts.dropDeletion(deletion.id)
      return true
    }
    await artifacts.markDeletionSwept(deletion.id, new Date(startedAt))
    return false
  }

  const deleteArtifact = async (orgId: string, artifactId: string): Promise<{ deletedAt: Date } | null> => {
    const deletedAt = new Date(now())
    const deletion = await artifacts.deleteRecording(orgId, artifactId, {
      deletedAt,
      purgeAfter: new Date(deletedAt.getTime() + purgeDelayMs)
    })
    if (!deletion) return null
    // The first sweep cuts off GETs signed before the deletion; a failure is left to the reaper.
    if (transfer) {
      await sweep(transfer, deletion).catch((err: unknown) => {
        deps.log?.warn({ err, artifactId }, 'artifact deletion sweep failed; the reaper retries it')
      })
    }
    return { deletedAt }
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

  /** The `stale-base` refusal (§5.6): the latest revision, and the paths changed since `baseRevision` while it is still kept. */
  const staleBase = async (
    orgId: string,
    artifactId: string,
    latestRevision: number,
    baseRevision: number | null
  ): Promise<ArtifactRefusal> => {
    const [latest, base] = await Promise.all([
      artifacts.getRevision(orgId, artifactId, latestRevision),
      baseRevision === null ? null : artifacts.getRevision(orgId, artifactId, baseRevision)
    ])
    if (latest?.state !== 'ready') return notFound()
    const details: ArtifactStaleBase = {
      ...(baseRevision === null ? {} : { baseRevision }),
      latest: {
        revision: latest.number,
        producedByAgentId: latest.producedByAgentId,
        producedByAgentName: latest.producedByAgentName,
        createdAt: latest.createdAt.toISOString()
      },
      ...(base?.state === 'ready' ? { changes: manifestChanges(base.manifest, latest.manifest) } : {})
    }
    const by = `${latest.producedByAgentName} at ${details.latest.createdAt}`
    const message =
      baseRevision === null
        ? `revision ${latest.number} (published by ${by}) became ready after this replacement began; publish again`
        : `revision ${latest.number} (published by ${by}) is now the latest, not revision ${baseRevision} this update was built on; fetch revision ${latest.number}, reapply the change and publish again on it`
    return new ArtifactRefusal('stale-base', 'CONFLICT', message, false, details)
  }

  return {
    async begin(orgId, agent, req, daemonId) {
      const bucket = requireTransfer()
      const over = artifactRevisionLimitProblem(req.manifest)
      if (over) {
        throw new ArtifactRefusal('revision-limit', 'BAD_PAYLOAD', over.message, false, {
          rule: over.rule,
          limit: over.limit,
          actual: over.actual
        })
      }
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
        idempotencyKey: req.idempotencyKey,
        uploadsSignedAt: new Date(now()),
        // Neither a base nor `replace` is a replacement, which is what a daemon older than §5.6 sends.
        baseRevision: req.baseRevision ?? null,
        ...(daemonId ? { publishedByDaemonId: daemonId } : {})
      }

      const limits = { orgBytesLimit: (await deps.orgBytesLimit?.(orgId)) ?? null }
      let result
      try {
        if (req.artifactId === undefined) {
          if (req.title === undefined)
            throw new ArtifactRefusal('title-required', 'BAD_PAYLOAD', 'a new artifact needs a title')
          const audience = artifactAudienceFromSession(
            { ...reachSessionOf(session), ownerIdentity: session.ownerIdentity },
            initiator
          )
          result = await artifacts.create(
            { ...audience, title: req.title, originSessionId: req.sessionId },
            revision,
            limits
          )
        } else {
          // Reach first, so an artifact the session may not see reads as absent rather than as someone else's.
          const artifact = await artifacts.get(orgId, req.artifactId)
          if (!artifact || !(await reaches(artifact, session))) throw notFound()
          const first = await artifacts.getRevision(orgId, artifact.id, 1)
          if (first?.producedByAgentId !== agent.id) {
            throw new ArtifactRefusal('not-producer', 'SCOPE_DENIED', 'an agent revises only the artifacts it produced')
          }
          result = await artifacts.appendRevision(orgId, artifact.id, revision, limits)
          if (!result) throw notFound()
        }
      } catch (err) {
        if (err instanceof ArtifactIdempotencyConflictError) {
          throw new ArtifactRefusal('idempotency-conflict', 'CONFLICT', err.message)
        }
        if (err instanceof ArtifactStaleBaseError && req.artifactId !== undefined) {
          // A base before any revision is ready names nothing the session could have fetched.
          if (err.latestRevision === 0) throw notFound()
          throw await staleBase(orgId, req.artifactId, err.latestRevision, req.baseRevision ?? null)
        }
        if (err instanceof ArtifactOrgLimitError) {
          throw new ArtifactRefusal(
            'org-limit',
            'CONFLICT',
            `the organization’s artifacts may hold at most ${formatArtifactBytes(err.limit)}; ${err.used} bytes are in use and this revision adds ${err.bytes} bytes`,
            false,
            { limit: err.limit, used: err.used, bytes: err.bytes }
          )
        }
        throw err
      }

      // A replay is answered from what its key recorded, before any base comparison (§5.6).
      if (result.replayed) {
        if (canonicalManifest(result.revision.manifest) !== canonicalManifest(req.manifest)) {
          throw new ArtifactRefusal('idempotency-conflict', 'CONFLICT', 'the idempotency key recorded another manifest')
        }
        if (result.revision.baseRevision !== (req.baseRevision ?? null)) {
          throw new ArtifactRefusal('idempotency-conflict', 'CONFLICT', 'the idempotency key recorded another base')
        }
        if (result.revision.state === 'ready') {
          return { state: 'ready', ...(await published(result.artifact, result.revision.number)) }
        }
        // Fresh PUTs restart the cleanup clock; one completed meanwhile answers ready, one the reaper removed is gone.
        const { artifactId, number } = result.revision
        if (!(await artifacts.touchUploads(orgId, artifactId, number, new Date(now())))) {
          const settled = await artifacts.getRevision(orgId, artifactId, number)
          if (settled?.state === 'ready') return { state: 'ready', ...(await published(result.artifact, number)) }
          throw notFound()
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
        // A deletion that landed while signing wins and no URL leaves, so its last sweep only waits out URLs signed before it.
        if (!(await artifacts.get(orgId, artifactId))) throw notFound()
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
      // Staleness only grows, so one seen without the lock skips the HEADs; the locked check below closes it.
      const current = await artifacts.get(orgId, req.artifactId)
      if (!current) throw notFound()
      const stale =
        revision.baseRevision === null
          ? current.latestRevision > revision.number
          : current.latestRevision !== revision.baseRevision
      if (revision.state === 'pending' && !stale) {
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
      const settled = await artifacts.markReady(orgId, req.artifactId, req.revision)
      if (!settled) throw notFound()
      if (settled.state === 'closed') {
        throw await staleBase(orgId, req.artifactId, settled.artifact.latestRevision, revision.baseRevision)
      }
      return await published(settled.artifact, req.revision)
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
        const shares = deps.shares
          ? (await deps.shares.listActive(orgId, row.id)).slice(0, ARTIFACT_LIST_SHARES_MAX).map((share) => ({
              shareId: share.id,
              revision: share.revisionNumber,
              audience: share.audience,
              displayTail: share.displayTail,
              createdAt: share.createdAt.toISOString()
            }))
          : undefined
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
          },
          ...(shares ? { shares } : {})
        }
      })
      const last = page.at(-1)
      return {
        artifacts: entries.filter((e): e is ArtifactListEntry => e !== null),
        ...(rows.length > ARTIFACT_LIST_PAGE_MAX && last ? { nextCursor: encodeArtifactCursor(last) } : {})
      }
    },

    async share(orgId, req) {
      const shares = requireShares()
      const session = await agentSession(orgId, req.agentId, req.sessionId)
      const artifact = await ownArtifact(orgId, req.agentId, req.artifactId, session)
      const viewer = await memberAuthority(orgId, req.agentId, req.initiator, artifact)
      const action = req.audience === 'public' ? ArtifactAction.SharePublic : ArtifactAction.ShareOrg
      if (!canActOnArtifact(action, artifact, viewer)) {
        throw new ArtifactRefusal(
          'share-forbidden',
          'SCOPE_DENIED',
          req.audience === 'public'
            ? 'only the artifact’s owner, or an organization owner who can view it, may share it publicly'
            : 'the person who started this turn cannot view this artifact'
        )
      }
      const revision = await artifacts.getRevision(orgId, artifact.id, req.revision ?? artifact.latestRevision)
      if (!revision) throw notFound()
      if (revision.state !== 'ready')
        throw new ArtifactRefusal('revision-not-ready', 'CONFLICT', 'this revision is still uploading')
      const created = await shares.create({
        orgId,
        artifactId: artifact.id,
        revisionNumber: revision.number,
        audience: req.audience,
        createdByIdentity: `user:${viewer.principal.userId}`
      })
      if (!created) throw notFound()
      return {
        shareId: created.share.id,
        artifactId: artifact.id,
        revision: created.share.revisionNumber,
        audience: created.share.audience,
        displayTail: created.share.displayTail,
        createdAt: created.share.createdAt.toISOString(),
        linkPath: created.linkPath,
        ...(created.link ? { link: created.link } : {})
      }
    },

    async unshare(orgId, req) {
      const shares = requireShares()
      const session = await agentSession(orgId, req.agentId, req.sessionId)
      const artifact = await ownArtifact(orgId, req.agentId, req.artifactId, session)
      const viewer = await memberAuthority(orgId, req.agentId, req.initiator, artifact)
      const share = await shares.get(orgId, artifact.id, req.shareId)
      if (!share) throw shareNotFound()
      if (!canRevokeArtifactShare(artifact, share, viewer)) {
        throw new ArtifactRefusal(
          'share-forbidden',
          'SCOPE_DENIED',
          'only the artifact’s owner, an organization owner, or the person who created the share may revoke it'
        )
      }
      const revoked = await shares.revoke(orgId, artifact.id, share.id)
      if (!revoked?.revokedAt) throw shareNotFound()
      return {
        shareId: revoked.id,
        artifactId: artifact.id,
        revision: revoked.revisionNumber,
        audience: revoked.audience,
        revokedAt: revoked.revokedAt.toISOString()
      }
    },

    async delete(orgId, req) {
      const session = await agentSession(orgId, req.agentId, req.sessionId)
      const artifact = await ownArtifact(orgId, req.agentId, req.artifactId, session, 'deletes')
      const viewer = await memberAuthority(orgId, req.agentId, req.initiator, artifact)
      if (!canActOnArtifact(ArtifactAction.Delete, artifact, viewer)) {
        throw new ArtifactRefusal(
          'delete-forbidden',
          'SCOPE_DENIED',
          'only the artifact’s owner or an organization owner may delete it'
        )
      }
      const deleted = await deleteArtifact(orgId, artifact.id)
      if (!deleted) throw notFound()
      return { artifactId: artifact.id, title: artifact.title, deletedAt: deleted.deletedAt.toISOString() }
    },

    deleteArtifact,

    async reap() {
      if (!transfer) return 0
      let dropped = 0
      let failure: unknown
      for (const deletion of await artifacts.dueDeletions(new Date(now()), REAP_BATCH)) {
        // One failed deletion never blocks the rest; its record stays for the next pass.
        try {
          if (await sweep(transfer, deletion)) dropped += 1
        } catch (err) {
          failure ??= err
        }
      }
      if (failure !== undefined) throw failure
      return dropped
    },

    async prune() {
      if (!transfer) return 0
      const at = new Date(now())
      let pruned = 0
      let failure: unknown
      for (const key of await artifacts.expiredRevisions(at, PRUNE_BATCH)) {
        try {
          // Re-decided under the artifact's lock: a share created or a retention changed since the scan keeps it.
          const deletion = await artifacts.expireRecording(key, { deletedAt: at, purgeAfter: at }, (facts) =>
            revisionExpired(facts, at.getTime())
          )
          if (!deletion) continue
          pruned += 1
          await sweep(transfer, deletion).catch((err: unknown) => {
            deps.log?.warn({ err, ...key }, 'expired artifact revision sweep failed; the reaper retries it')
          })
        } catch (err) {
          failure ??= err
        }
      }
      if (failure !== undefined) throw failure
      return pruned
    },

    async removeUnfinished() {
      if (!transfer) return 0
      const at = new Date(now())
      let removed = 0
      let failure: unknown
      for (const key of await artifacts.unfinishedRevisions(new Date(at.getTime() - purgeDelayMs), UNFINISHED_BATCH)) {
        try {
          // Every PUT signed for it has expired, so one sweep is the last; a replay since the scan keeps it.
          const deletion = await artifacts.removeUnfinished(key, { deletedAt: at, purgeAfter: at }, (facts) =>
            unfinishedRevisionExpired(facts, at.getTime(), purgeDelayMs)
          )
          if (!deletion) continue
          removed += 1
          await sweep(transfer, deletion).catch((err: unknown) => {
            deps.log?.warn({ err, ...key }, 'unfinished artifact revision sweep failed; the reaper retries it')
          })
        } catch (err) {
          failure ??= err
        }
      }
      if (failure !== undefined) throw failure
      return removed
    },

    async fileDownload(revision, path) {
      if (!transfer || !revision.manifest.files.some((f) => f.path === path)) return undefined
      return await transfer.signDownload({ key: artifactObjectKey(revision.storagePrefix, path), name: basename(path) })
    }
  }
}

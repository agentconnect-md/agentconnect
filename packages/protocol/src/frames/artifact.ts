import { z } from 'zod'
import { TransferNetwork } from './file-transfer.js'

// Artifacts (docs/designs/artifacts.md): the daemon publishes, fetches and lists over CP-signed URLs; bytes never ride this WS.

/** This CP answers `artifact/publish/begin|complete`, `artifact/fetch` and `artifact/list` (artifacts.md §5.3). */
export const ARTIFACTS_FEATURE = 'artifacts-v1'
/** This CP also answers `artifact/share` and `artifact/unshare`, and lists active shares (artifacts.md §7.1, §8.3). */
export const ARTIFACT_SHARES_FEATURE = 'artifact-shares-v1'

/** Files one revision may hold (artifacts.md §10.2, P4). */
export const ARTIFACT_MAX_FILES = 200
/** Bytes one revision may hold across its files (artifacts.md §10.2, P4). */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024
/** UTF-8 bytes of one manifest path, so the whole object key stays inside S3's 1024-byte limit. */
export const ARTIFACT_PATH_MAX_BYTES = 768
/** UTF-8 bytes of one path segment, the common filesystem limit. */
export const ARTIFACT_SEGMENT_MAX_BYTES = 255
export const ARTIFACT_TITLE_MAX = 200
/** Artifacts one `artifact/list` page holds at most. */
export const ARTIFACT_LIST_PAGE_MAX = 25
/** Active shares one list entry carries at most, newest first. */
export const ARTIFACT_LIST_SHARES_MAX = 20

const CONTROL_RE = /[\u0000-\u001f\u007f]/
const utf8 = new TextEncoder()
const utf8Bytes = (text: string): number => utf8.encode(text).length

/** Why a manifest path breaks §5.4, or undefined when it is a relative POSIX path the store and a checkout both accept. */
export function artifactPathProblem(path: string): string | undefined {
  if (path.length === 0) return 'the path is empty'
  if (utf8Bytes(path) > ARTIFACT_PATH_MAX_BYTES) return `the path is longer than ${ARTIFACT_PATH_MAX_BYTES} bytes`
  if (path.startsWith('/')) return 'the path is absolute'
  if (path.includes('\\')) return 'the path contains a backslash'
  if (CONTROL_RE.test(path)) return 'the path contains a control character'
  // The shim and its worker own `/__ac/` on every revision origin (artifacts.md §5.5).
  if (path.toLowerCase().startsWith('__ac/')) return 'the path is under `__ac/`, which is reserved'
  for (const segment of path.split('/')) {
    if (segment === '') return 'the path has an empty segment'
    if (segment === '.' || segment === '..') return 'the path has a `.` or `..` segment'
    if (segment.toLowerCase() === '.git') return 'the path has a `.git` component'
    if (utf8Bytes(segment) > ARTIFACT_SEGMENT_MAX_BYTES)
      return `a path segment is longer than ${ARTIFACT_SEGMENT_MAX_BYTES} bytes`
  }
  return undefined
}

/** The form two paths collide in: Unicode NFC, then case-folded (upper then lower folds `ß` with `SS`). */
export function artifactPathFoldKey(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')
}

export const ArtifactPath = z
  .string()
  .min(1)
  .max(ARTIFACT_PATH_MAX_BYTES)
  .superRefine((path, ctx) => {
    const problem = artifactPathProblem(path)
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
  })

/** Lower-case hex SHA-256 of a file's bytes, the manifest's form. */
export const ArtifactSha256 = z.string().regex(/^[0-9a-f]{64}$/)

/** A bare `type/subtype`; the console renders a single file by it (artifacts.md §9). */
export const ArtifactMediaType = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/)

export const ArtifactManifestFile = z.object({
  path: ArtifactPath,
  sha256: ArtifactSha256,
  // An empty file has nothing to sign a checksum PUT for; the daemon leaves it out.
  bytes: z.number().int().positive().max(ARTIFACT_MAX_BYTES),
  mediaType: ArtifactMediaType
})
export type ArtifactManifestFile = z.infer<typeof ArtifactManifestFile>

/** One revision's content (artifacts.md §4, §5.4): paths unique after folding, no file inside another, the entry one of them. */
export const ArtifactManifest = z
  .object({
    entry: ArtifactPath,
    files: z.array(ArtifactManifestFile).min(1).max(ARTIFACT_MAX_FILES)
  })
  .superRefine((manifest, ctx) => {
    const folded = new Map<string, string>()
    let total = 0
    for (const file of manifest.files) {
      total += file.bytes
      const key = artifactPathFoldKey(file.path)
      const clash = folded.get(key)
      if (clash !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `\`${file.path}\` collides with \`${clash}\`` })
        return
      }
      folded.set(key, file.path)
    }
    for (const file of manifest.files) {
      const segments = artifactPathFoldKey(file.path).split('/')
      for (let i = 1; i < segments.length; i += 1) {
        const parent = folded.get(segments.slice(0, i).join('/'))
        if (parent !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `\`${file.path}\` is inside the file \`${parent}\`` })
          return
        }
      }
    }
    if (total > ARTIFACT_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `a revision holds at most ${ARTIFACT_MAX_BYTES} bytes` })
    }
    if (!manifest.files.some((file) => file.path === manifest.entry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'the entry must be one of the files', path: ['entry'] })
    }
  })
export type ArtifactManifest = z.infer<typeof ArtifactManifest>

export const ArtifactTitle = z
  .string()
  .max(ARTIFACT_TITLE_MAX)
  .refine((title) => title.trim().length > 0 && !CONTROL_RE.test(title), 'a title is non-blank text on one line')

/** Who started the publishing turn, so the CP can resolve owner and provenance (artifacts.md §6.1, §7.3). */
export const ArtifactInitiator = z.discriminatedUnion('kind', [
  /** A signed-in console user. */
  z.object({ kind: z.literal('console'), userId: z.string().min(1).max(256) }),
  /** A chat member on one of the agent's bots; the CP resolves whether a console member linked it. */
  z.object({ kind: z.literal('chat'), integrationId: z.string().uuid(), memberId: z.string().min(1).max(256) }),
  /** A cron run; its creator owns what it publishes. */
  z.object({ kind: z.literal('cron'), cronId: z.string().min(1).max(256) }),
  /** A hook run; its creator owns what it publishes. */
  z.object({ kind: z.literal('hook'), hookId: z.string().min(1).max(256) })
])
export type ArtifactInitiator = z.infer<typeof ArtifactInitiator>

export const ArtifactVisibility = z.enum(['private', 'org', 'external', 'editors'])
export type ArtifactVisibility = z.infer<typeof ArtifactVisibility>

/** Who sees the artifact now, so the agent can tell the person (artifacts.md §7.2). */
export const ArtifactAudienceSummary = z.object({
  visibility: ArtifactVisibility,
  /** The platform whose source scope an `external` artifact follows. */
  externalProvider: z.string().min(1).max(64).optional(),
  /** False for an artifact with no owner, which organization owners manage. */
  owned: z.boolean()
})
export type ArtifactAudienceSummary = z.infer<typeof ArtifactAudienceSummary>

/** A ready revision as the publish result reports it. */
export const ArtifactPublished = z.object({
  artifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  title: ArtifactTitle,
  /** The console path pinned to this revision, `/<org slug>/artifacts/<id>?revision=<n>` (artifacts.md §8.2). */
  linkPath: z.string().min(1).max(512),
  /** The same link on the console's origin, when the CP knows it. */
  link: z.string().url().optional(),
  audience: ArtifactAudienceSummary
})
export type ArtifactPublished = z.infer<typeof ArtifactPublished>

/** One file's presigned PUT. */
export const ArtifactUpload = z.object({
  path: ArtifactPath,
  url: z.string().url(),
  /** The exact headers the PUT signed; send them unchanged with the file's bytes. */
  headers: z.record(z.string(), z.string())
})
export type ArtifactUpload = z.infer<typeof ArtifactUpload>

/** A retry key, unique per producing agent; a retried publish with it gets the same revision back. */
export const ArtifactIdempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

/** D→C REQ: record a pending revision, a new artifact when `artifactId` is absent, and presign one PUT per file. */
export const ArtifactPublishBeginReq = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  /** Append to this artifact; the agent must have produced its revision 1 and the session must reach it. */
  artifactId: z.string().uuid().optional(),
  /** Required to create; an append keeps the artifact's title, which only people rename. */
  title: ArtifactTitle.optional(),
  manifest: ArtifactManifest,
  idempotencyKey: ArtifactIdempotencyKey,
  network: TransferNetwork,
  /** Absent for a turn no person or trigger started: the artifact then has no owner. */
  initiator: ArtifactInitiator.optional()
})
export type ArtifactPublishBeginReq = z.infer<typeof ArtifactPublishBeginReq>

/** C→D REP: PUTs for a pending revision, or the ready result a replayed key already reached. */
export const ArtifactPublishBeginOk = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('pending'),
    artifactId: z.string().uuid(),
    revision: z.number().int().positive(),
    /** One per manifest file, in manifest order. */
    uploads: z.array(ArtifactUpload).max(ARTIFACT_MAX_FILES),
    /** When the PUTs stop being accepted, epoch milliseconds. */
    expiresAt: z.number().int()
  }),
  ArtifactPublished.extend({ state: z.literal('ready') })
])
export type ArtifactPublishBeginOk = z.infer<typeof ArtifactPublishBeginOk>

/** D→C REQ: every PUT succeeded; the CP checks each object before the revision becomes ready. */
export const ArtifactPublishCompleteReq = z.object({
  agentId: z.string().uuid(),
  artifactId: z.string().uuid(),
  revision: z.number().int().positive()
})
export type ArtifactPublishCompleteReq = z.infer<typeof ArtifactPublishCompleteReq>

/** C→D REP: the ready revision; a repeated complete answers the same. */
export const ArtifactPublishCompleteOk = ArtifactPublished
export type ArtifactPublishCompleteOk = z.infer<typeof ArtifactPublishCompleteOk>

/** D→C REQ: presign GETs for one ready revision the session reaches; the latest when `revision` is absent. */
export const ArtifactFetchReq = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  artifactId: z.string().uuid(),
  revision: z.number().int().positive().optional(),
  network: TransferNetwork
})
export type ArtifactFetchReq = z.infer<typeof ArtifactFetchReq>

export const ArtifactDownload = z.object({ path: ArtifactPath, url: z.string().url() })
export type ArtifactDownload = z.infer<typeof ArtifactDownload>

/** C→D REP: the revision's manifest and one GET per file, in manifest order; verify each file against its digest. */
export const ArtifactFetchOk = z.object({
  artifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  title: ArtifactTitle,
  manifest: ArtifactManifest,
  downloads: z.array(ArtifactDownload).max(ARTIFACT_MAX_FILES),
  expiresAt: z.number().int()
})
export type ArtifactFetchOk = z.infer<typeof ArtifactFetchOk>

/** D→C REQ: one page of the artifacts the session reaches, newest-updated first. */
export const ArtifactListReq = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  /** The previous page's `nextCursor`; opaque. */
  cursor: z.string().min(1).max(512).optional()
})
export type ArtifactListReq = z.infer<typeof ArtifactListReq>

export const ArtifactShareAudience = z.enum(['public', 'org'])
export type ArtifactShareAudience = z.infer<typeof ArtifactShareAudience>

/** An active share as the agent sees it; never its token, which only the creating reply carries. */
export const ArtifactShareSummary = z.object({
  shareId: z.string().uuid(),
  revision: z.number().int().positive(),
  audience: ArtifactShareAudience,
  /** The token's last characters, so a person can tell links apart. */
  displayTail: z.string().min(1).max(16),
  createdAt: z.string().datetime()
})
export type ArtifactShareSummary = z.infer<typeof ArtifactShareSummary>

export const ArtifactListEntry = z.object({
  artifactId: z.string().uuid(),
  title: ArtifactTitle,
  audience: ArtifactAudienceSummary,
  /** True when this agent produced revision 1, so it may append. */
  producedByAgent: z.boolean(),
  updatedAt: z.string().datetime(),
  latest: z.object({
    revision: z.number().int().positive(),
    entry: ArtifactPath,
    entryMediaType: ArtifactMediaType,
    fileCount: z.number().int().positive(),
    totalBytes: z.number().int().positive(),
    producedByAgentName: z.string(),
    createdAt: z.string().datetime()
  }),
  /** Its active shares, newest first; absent from a CP without `artifact-shares-v1`. */
  shares: z.array(ArtifactShareSummary).max(ARTIFACT_LIST_SHARES_MAX).optional()
})
export type ArtifactListEntry = z.infer<typeof ArtifactListEntry>

/** C→D REP: the page and, when more follow, the cursor for the next. */
export const ArtifactListOk = z.object({
  artifacts: z.array(ArtifactListEntry).max(ARTIFACT_LIST_PAGE_MAX),
  nextCursor: z.string().min(1).max(512).optional()
})
export type ArtifactListOk = z.infer<typeof ArtifactListOk>

/** D→C REQ: share one ready revision of an artifact this agent produced and the session reaches, as the turn's member (§7.3). */
export const ArtifactShareReq = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  artifactId: z.string().uuid(),
  /** Absent shares the latest ready revision. */
  revision: z.number().int().positive().optional(),
  audience: ArtifactShareAudience,
  /** Whose §6.3 authority the share uses; absent, or not resolving to a member, is refused. */
  initiator: ArtifactInitiator.optional()
})
export type ArtifactShareReq = z.infer<typeof ArtifactShareReq>

/** C→D REP: the new share and its link, which carries the token and is returned only here. */
export const ArtifactShareOk = ArtifactShareSummary.extend({
  artifactId: z.string().uuid(),
  /** The console path, `/share/<token>` (artifacts.md §8.3). */
  linkPath: z.string().min(1).max(512),
  /** The same link on the console's origin, when the CP knows it. */
  link: z.string().url().optional()
})
export type ArtifactShareOk = z.infer<typeof ArtifactShareOk>

/** D→C REQ: revoke one share, by its id, of an artifact this agent produced and the session reaches. */
export const ArtifactUnshareReq = z.object({
  agentId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  artifactId: z.string().uuid(),
  shareId: z.string().uuid(),
  initiator: ArtifactInitiator.optional()
})
export type ArtifactUnshareReq = z.infer<typeof ArtifactUnshareReq>

/** C→D REP: the revoked share; repeating an unshare answers the first revocation again. */
export const ArtifactUnshareOk = z.object({
  shareId: z.string().uuid(),
  artifactId: z.string().uuid(),
  revision: z.number().int().positive(),
  audience: ArtifactShareAudience,
  revokedAt: z.string().datetime()
})
export type ArtifactUnshareOk = z.infer<typeof ArtifactUnshareOk>

/** `details.reason` of an `error` reply to an artifact frame; a string on the wire so a newer CP's reason still parses. */
export const ArtifactRefusalReason = z.enum([
  /** The deployment does not offer artifacts: it has no transfer bucket or no content domain (artifacts.md §12). */
  'not-enabled',
  /** The transfer bucket is unavailable now (retryable). */
  'transfer-unavailable',
  /** The CP has no row for the session yet (retryable). */
  'session-unknown',
  /** The session belongs to another agent, or its content was deleted. */
  'session-denied',
  /** No such artifact or revision, or the session's audience may not see it (§7.2). */
  'not-found',
  /** The artifact exists and is reachable, but this agent did not produce its revision 1 (§7.2). */
  'not-producer',
  /** A file is larger than one transfer may carry. */
  'too-large',
  /** The idempotency key was already used for a different publication. */
  'idempotency-conflict',
  /** A create named no title. */
  'title-required',
  /** At complete, an object is missing or does not hold the declared bytes. */
  'incomplete',
  /** The turn has no organization member's authority: a non-member, an unlinked sender, or a trigger without a member creator (§7.3). */
  'no-member-authority',
  /** The member may not do this under §6.3, such as a `public` share by someone who is not the owner. */
  'share-forbidden',
  /** The revision is still uploading. */
  'revision-not-ready',
  /** No such share on that artifact. */
  'share-not-found'
])
export type ArtifactRefusalReason = z.infer<typeof ArtifactRefusalReason>

// ── The transcript marker a publication leaves (1c writes it, the console card parses it) ──

export interface ArtifactMarker {
  artifactId: string
  revision: number
  title: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MARKER_RE = /(?:^|\n)\[artifact: ([0-9a-f-]{36}) r([1-9]\d{0,8}) ("(?:[^"\\\n]|\\.)*")\]$/

/** `[artifact: <id> r<n> "<title>"]`: the title is a JSON string, so quotes, brackets and newlines cannot break the line. */
export function formatArtifactMarker(marker: ArtifactMarker): string {
  if (!UUID_RE.test(marker.artifactId)) throw new Error('artifact id must be a lower-case UUID')
  if (!Number.isSafeInteger(marker.revision) || marker.revision < 1 || marker.revision > 999_999_999)
    throw new Error('revision must be a positive integer')
  return `[artifact: ${marker.artifactId} r${marker.revision} ${JSON.stringify(marker.title)}]`
}

/** The marker on a text's last line and the caption before it, or null when the text ends in none. */
export function parseArtifactMarker(text: string): { caption: string; artifact: ArtifactMarker } | null {
  const match = MARKER_RE.exec(text)
  if (!match) return null
  const [whole, artifactId, revision, quoted] = match as unknown as [string, string, string, string]
  if (!UUID_RE.test(artifactId)) return null
  let title: unknown
  try {
    title = JSON.parse(quoted)
  } catch {
    return null
  }
  if (typeof title !== 'string') return null
  const caption = text.slice(0, text.length - whole.length)
  return { caption, artifact: { artifactId, revision: Number(revision), title } }
}

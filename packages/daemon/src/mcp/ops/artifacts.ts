// The artifact tools (artifacts.md §7): publish, fetch and list toward `artifacts-v1`, share and unshare toward `artifact-shares-v1`, delete toward `artifact-delete-v1`.
import { createHash } from 'node:crypto'
import { WireError } from '@agentconnect.md/connection'
import {
  ARTIFACT_PATH_MAX_BYTES,
  ARTIFACT_TITLE_MAX,
  artifactPathProblem,
  formatArtifactMarker,
  type ArtifactAudienceSummary,
  type ArtifactDeleteOk,
  type ArtifactDeleteReq,
  type ArtifactFetchOk,
  type ArtifactFetchReq,
  type ArtifactInitiator,
  type ArtifactListOk,
  type ArtifactListReq,
  type ArtifactPublishBeginOk,
  type ArtifactPublishBeginReq,
  type ArtifactPublishCompleteOk,
  type ArtifactPublishCompleteReq,
  type ArtifactPublished,
  type ArtifactShareAudience,
  type ArtifactShareOk,
  type ArtifactShareReq,
  type ArtifactUnshareOk,
  type ArtifactUnshareReq,
  type TransferNetwork
} from '@agentconnect.md/protocol'
import { z } from 'zod'
import { obj, type ToolDescriptor } from '../../tool-schema/descriptor.js'
import {
  isCheckCoordinate,
  isGettingToKnowCoordinate,
  isResearchCoordinate
} from '../../session/subsession-coordinate.js'
import { platformLabel } from '../../platforms/read-ports.js'
import {
  artifactDirName,
  artifactIdempotencyKey,
  ArtifactToolError,
  buildArtifactManifest,
  type ArtifactSourceFile,
  type ArtifactSourceTree
} from '../../artifacts/manifest.js'
import type { ArtifactFilePut } from '../../artifacts/outputs-dir.js'
import { PutObjectError } from '../../source-cache/put-object.js'
import { parseArgs, requiredString } from './args.js'
import type { SessionContext, ToolHandler } from './context.js'

/** The live turn a call publishes from, as the CP knows it. */
export interface ArtifactTurn {
  /** The session's outward id. */
  sessionId: string
  /** Stable for the live turn, so a retried call inside it maps to the same revision. */
  turn: string
  initiator?: ArtifactInitiator
}

export type ArtifactSourceResult =
  { ok: true; tree: ArtifactSourceTree } | { ok: false; reason: 'sandboxed' | 'not-found' | 'escape' }

export type ArtifactOutputsResult =
  | { ok: true; path: string; name: string }
  | { ok: false; reason: 'sandboxed' | 'no-workspace' | 'escape' | 'write-failed'; detail?: string }

export interface ArtifactPort {
  /** Whether the connected CP answers the artifact frames. */
  served(): boolean
  /** Whether it also answers `artifact/share|unshare`. */
  sharesServed(): boolean
  /** Whether it also answers `artifact/delete`. */
  deleteServed(): boolean
  turn(ctx: SessionContext): Promise<ArtifactTurn | undefined>
  begin(req: ArtifactPublishBeginReq): Promise<ArtifactPublishBeginOk>
  complete(req: ArtifactPublishCompleteReq): Promise<ArtifactPublishCompleteOk>
  fetch(req: ArtifactFetchReq): Promise<ArtifactFetchOk>
  list(req: ArtifactListReq): Promise<ArtifactListOk>
  share(req: ArtifactShareReq): Promise<ArtifactShareOk>
  unshare(req: ArtifactUnshareReq): Promise<ArtifactUnshareOk>
  delete(req: ArtifactDeleteReq): Promise<ArtifactDeleteOk>
  network(): TransferNetwork
  /** The largest file one transfer carries here, clamped to the revision limit. */
  maxFileBytes(): number
  /** The `files:` name of a session-file path, so results never carry a host path. */
  normalizePath(ctx: SessionContext, path: string): Promise<string>
  /** `shareFile`'s resolver and fence, as a tree to walk. */
  source(ctx: SessionContext, path: string): Promise<ArtifactSourceResult>
  /** The card's transcript row, durable before any live view shows it; a notice when only the live view failed. */
  recordCard(ctx: SessionContext, text: string): Promise<{ notice?: string } | void>
  /** `outputs/<dirName>/` replaced by what `fill` puts, through the host or pod write path uploads use. */
  writeOutputs(
    ctx: SessionContext,
    dirName: string,
    fill: (put: ArtifactFilePut) => Promise<void>
  ): Promise<ArtifactOutputsResult>
  put(upload: { url: string; headers: Record<string, string> }, bytes: Buffer): Promise<void>
  download(url: string, maxBytes: number): Promise<Buffer>
  /** Cards this process already wrote, so a replayed publish leaves one card per revision. */
  cards: Set<string>
}

export interface ArtifactToolDeps {
  artifacts?: ArtifactPort
}

const ARTIFACT_ID = z
  .string('argument artifactId must be a string')
  .uuid('argument artifactId must be an artifact id from publishArtifact or listArtifacts')
  .transform((id) => id.toLowerCase())

export const PUBLISH_ARTIFACT_ARGS = z.object({
  path: requiredString('path').max(1024, 'argument path must be at most 1024 characters'),
  title: z
    .string('argument title must be a string')
    .trim()
    .min(1, 'argument title must not be blank')
    .max(ARTIFACT_TITLE_MAX, `argument title must be at most ${ARTIFACT_TITLE_MAX} characters`)
    .refine((title) => !/[\u0000-\u001f\u007f]/.test(title), 'argument title must be one line of plain text')
    .optional(),
  entry: z
    .string('argument entry must be a string')
    .min(1, 'argument entry must not be empty')
    .max(ARTIFACT_PATH_MAX_BYTES)
    .optional(),
  artifactId: ARTIFACT_ID.optional()
})

export const FETCH_ARTIFACT_ARGS = z.object({
  artifactId: ARTIFACT_ID,
  revision: z
    .number('argument revision must be a number')
    .int()
    .positive('argument revision must be 1 or more')
    .optional()
})

export const LIST_ARTIFACTS_ARGS = z.object({
  cursor: z.string('argument cursor must be a string').min(1).max(512).optional()
})

export const SHARE_ARTIFACT_ARGS = z.object({
  artifactId: ARTIFACT_ID,
  audience: z.enum(['public', 'org'], 'argument audience must be "org" or "public"'),
  revision: z
    .number('argument revision must be a number')
    .int()
    .positive('argument revision must be 1 or more')
    .optional()
})

export const UNSHARE_ARTIFACT_ARGS = z.object({
  artifactId: ARTIFACT_ID,
  shareId: z
    .string('argument shareId must be a string')
    .uuid('argument shareId must be a share id from shareArtifact or listArtifacts')
    .transform((id) => id.toLowerCase())
})

export const PUBLISH_ARTIFACT_TOOL: ToolDescriptor = {
  name: 'publishArtifact',
  description:
    'Publish a file or a directory as an artifact: a versioned deliverable people open, keep and share from the ' +
    'AgentConnect console, such as an HTML page, a report, a Markdown document, a chart, a PDF or source. Use it ' +
    'when the person should open the result or come back to it later; use shareFile to drop a file into this ' +
    'conversation instead. To change something you published, edit the files and publish again with its ' +
    '`artifactId`: that adds a revision rather than a near-duplicate. The result’s `link` is what you give the ' +
    'person: put it in your reply, because publishing posts nothing to a chat platform. Tell them who can open it, ' +
    'from `whoCanOpen`. A directory publishes every file in it as one revision and needs `entry`, the file that ' +
    'opens first. The console shows the entry file alone, so make an HTML page self-contained (inline styles, ' +
    'scripts and images). Empty files, links and special files are refused.',
  inputSchema: obj(
    {
      path: {
        type: 'string',
        minLength: 1,
        description:
          'A file or directory: a session file (`files:outputs/report.html`, or its absolute path in the session ' +
          'files directory) or a workspace-relative path. Other absolute paths and `..` are rejected.'
      },
      title: {
        type: 'string',
        maxLength: ARTIFACT_TITLE_MAX,
        description:
          'Required for a new artifact: a short name people recognize, e.g. "Q3 revenue report". A new revision ' +
          'keeps the artifact’s title.'
      },
      entry: {
        type: 'string',
        description: 'For a directory: the path, relative to it, of the file that opens first (e.g. `index.html`).'
      },
      artifactId: {
        type: 'string',
        description: 'Publish a new revision of an artifact you published (from an earlier result or listArtifacts).'
      }
    },
    ['path']
  )
}

export const FETCH_ARTIFACT_TOOL: ToolDescriptor = {
  name: 'fetchArtifact',
  description:
    'Download one revision of an artifact into your session outputs to keep working on it, for example after its ' +
    'workspace was cleaned up. Its files land in the returned `files:outputs/…` directory, replacing what an ' +
    'earlier fetch of the same artifact left there. Defaults to the latest revision. Edit them there, then ' +
    'publishArtifact that directory (or the single file) with the same `artifactId` to publish the next revision.',
  inputSchema: obj(
    {
      artifactId: { type: 'string', description: 'The artifact, from publishArtifact or listArtifacts.' },
      revision: { type: 'integer', minimum: 1, description: 'A specific revision; omit for the latest.' }
    },
    ['artifactId']
  )
}

export const LIST_ARTIFACTS_TOOL: ToolDescriptor = {
  name: 'listArtifacts',
  description:
    'List the artifacts this conversation can reach, most recently updated first, with each one’s latest revision, ' +
    'whether you may publish new revisions of it (`canRevise`) and its active share links (`shares`, when sharing ' +
    'is offered). Pass the returned `nextCursor` for the next page.',
  inputSchema: obj({ cursor: { type: 'string', description: 'The previous page’s `nextCursor`.' } })
}

export const SHARE_ARTIFACT_TOOL: ToolDescriptor = {
  name: 'shareArtifact',
  description:
    'Create a share link to one revision of an artifact you published, so people outside this conversation can ' +
    'open it. `audience: "org"` admits signed-in members of the organization. `audience: "public"` admits anyone ' +
    'who has the link, without signing in: use it only when the person asks for a public link, and tell them that ' +
    'anyone with the link can open it and that copies already downloaded cannot be recalled, even after the link ' +
    'is revoked. The link stays on that revision; a later revision needs a new share. The result’s `link` is what ' +
    'you give the person, and it is shown only this once. You act for the person who started this turn: a public ' +
    'link needs the artifact’s owner or an organization owner, and a guest or a chat account not linked to a ' +
    'console member cannot share at all.',
  inputSchema: obj(
    {
      artifactId: { type: 'string', description: 'An artifact you published, from publishArtifact or listArtifacts.' },
      audience: {
        type: 'string',
        enum: ['org', 'public'],
        description: '"org" for signed-in organization members, "public" for anyone with the link.'
      },
      revision: { type: 'integer', minimum: 1, description: 'A specific revision; omit for the latest.' }
    },
    ['artifactId', 'audience']
  )
}

export const UNSHARE_ARTIFACT_TOOL: ToolDescriptor = {
  name: 'unshareArtifact',
  description:
    'Revoke one share link of an artifact you published; the link stops opening at once, but copies people already ' +
    'downloaded are not recalled. Pass the `shareId` from shareArtifact or from the artifact’s `shares` in ' +
    'listArtifacts; to find the share behind a link someone pastes, match the link’s last six characters against ' +
    '`displayTail`. You act for the person who started this turn: the artifact’s owner, an organization owner, or ' +
    'whoever created the share may revoke it.',
  inputSchema: obj(
    {
      artifactId: { type: 'string', description: 'The shared artifact.' },
      shareId: { type: 'string', description: 'The share to revoke.' }
    },
    ['artifactId', 'shareId']
  )
}

export const DELETE_ARTIFACT_ARGS = z.object({ artifactId: ARTIFACT_ID })

export const DELETE_ARTIFACT_TOOL: ToolDescriptor = {
  name: 'deleteArtifact',
  description:
    'Delete an artifact you published, for good: every revision, its stored files and every share link to it go at ' +
    'once, its links stop opening, and it cannot be recovered. Copies people already downloaded are not recalled. ' +
    'Use it only when the person clearly asks to delete that artifact, and confirm which one (by its title from ' +
    'listArtifacts) when there is any doubt; to stop a share link only, use unshareArtifact instead. You act for ' +
    'the person who started this turn: only the artifact’s owner or an organization owner may delete it, and a ' +
    'guest or a chat account not linked to a console member cannot delete at all.',
  inputSchema: obj(
    {
      artifactId: { type: 'string', description: 'An artifact you published, from publishArtifact or listArtifacts.' }
    },
    ['artifactId']
  )
}

export const ARTIFACT_TOOLS: ToolDescriptor[] = [PUBLISH_ARTIFACT_TOOL, FETCH_ARTIFACT_TOOL, LIST_ARTIFACTS_TOOL]
export const ARTIFACT_SHARE_TOOLS: ToolDescriptor[] = [SHARE_ARTIFACT_TOOL, UNSHARE_ARTIFACT_TOOL]
export const ARTIFACT_DELETE_TOOLS: ToolDescriptor[] = [DELETE_ARTIFACT_TOOL]

const narrowed = (thread: string): boolean =>
  isCheckCoordinate(thread) || isResearchCoordinate(thread) || isGettingToKnowCoordinate(thread)

/** The tools a session is offered: toward a CP that serves them, never in a check, research or getting-to-know task. */
export function artifactToolsFor(
  served: boolean,
  at: { thread: string },
  sharesServed = false,
  deleteServed = false
): ToolDescriptor[] {
  if (!served || narrowed(at.thread)) return []
  return [
    ...ARTIFACT_TOOLS,
    ...(sharesServed ? ARTIFACT_SHARE_TOOLS : []),
    ...(deleteServed ? ARTIFACT_DELETE_TOOLS : [])
  ]
}

function portFor(
  ctx: SessionContext,
  deps: ArtifactToolDeps,
  name: string,
  needs: 'shares' | 'delete' | undefined = undefined
): ArtifactPort {
  const port = deps.artifacts
  const extra = needs === 'shares' ? port?.sharesServed() : needs === 'delete' ? port?.deleteServed() : true
  if (!port?.served() || !extra || narrowed(ctx.thread)) throw new Error(`${name} is not available in this session.`)
  return port
}

async function turnFor(ctx: SessionContext, port: ArtifactPort, name: string): Promise<ArtifactTurn> {
  const turn = await port.turn(ctx)
  if (!turn) throw new Error(`${name}: this session has no live turn the control plane knows yet — try again shortly.`)
  return turn
}

/** What each `ArtifactRefusalReason` tells the agent; the CP's own message follows where it adds detail. */
const REFUSALS: Record<string, (name: string, err: WireError) => string> = {
  'not-enabled': (name) =>
    `${name}: artifacts are not enabled on this deployment. Use shareFile to hand the file over in this conversation instead.`,
  'transfer-unavailable': (name) =>
    `${name}: artifact storage is unavailable right now — try again shortly. If it persists, use shareFile to hand ` +
    'the file over in this conversation instead.',
  'session-unknown': (name) => `${name}: the control plane does not know this session yet — try again in a moment.`,
  'session-denied': (name) =>
    `${name}: this session may not use artifacts (it belongs to another agent, or its content was deleted).`,
  'not-found': (name) =>
    `${name}: no such artifact or revision that this conversation can reach. listArtifacts shows the ones it can.`,
  'not-producer': (name) =>
    name === 'publishArtifact'
      ? `${name}: you can publish revisions only of artifacts you created. Leave out artifactId to publish this as a new artifact.`
      : name === 'deleteArtifact'
        ? `${name}: you can delete only artifacts you created; a person can delete it from the artifact in the console.`
        : `${name}: you can share and unshare only artifacts you created; a person can do it from the artifact in the console.`,
  'too-large': (name, err) => `${name}: a file is over this deployment’s size limit (${err.message}).`,
  'revision-limit': (name, err) =>
    `${name}: ${err.message}; nothing was published. Publish fewer or smaller files, for example only what the page needs.`,
  'org-limit': (name, err) =>
    `${name}: ${err.message}; nothing was published, and nothing already published was removed. Tell the person: ` +
    'an artifact’s owner or an organization owner can free space by deleting artifacts that are no longer needed.',
  'idempotency-conflict': (name) =>
    `${name}: this publication collided with an earlier one from this turn — publish again.`,
  'title-required': (name) => `${name}: a new artifact needs a \`title\`.`,
  incomplete: (name, err) => {
    const paths = Array.isArray(err.details?.paths) ? (err.details.paths as unknown[]).map(String) : []
    return (
      `${name}: the upload did not complete${paths.length ? ` for ${paths.map((p) => `"${p}"`).join(', ')}` : ''}; ` +
      'nothing was published. Publish again.'
    )
  },
  'no-member-authority': (name) =>
    `${name}: only an organization member can ${name === 'deleteArtifact' ? 'delete' : 'share or unshare'}, and the person who started this turn is not one ` +
    'AgentConnect recognizes (a guest, a chat account not linked to a console member, or a schedule without a ' +
    'member owner). A member can do it from the artifact in the console, or link their chat account and ask again.',
  'share-forbidden': (name, err) =>
    `${name}: the person who started this turn may not do this (${err.message}). An "org" share is open to anyone ` +
    'who can view the artifact.',
  'revision-not-ready': (name) =>
    `${name}: that revision is still uploading. Share it once publishArtifact has finished, or omit revision.`,
  'share-not-found': (name) =>
    `${name}: no such share on this artifact. listArtifacts shows each artifact’s active shares.`,
  'delete-forbidden': (name) =>
    `${name}: only the artifact’s owner or an organization owner may delete it, and the person who started this ` +
    'turn is neither. Nothing was deleted; the owner can delete it from the artifact in the console.'
}

/** A CP call whose refusal becomes a sentence the agent can act on. */
async function cp<T>(name: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof WireError) {
      const reason = typeof err.details?.reason === 'string' ? err.details.reason : undefined
      const refusal = reason ? REFUSALS[reason] : undefined
      if (refusal) throw new Error(refusal(name, err))
      throw new Error(`${name}: the control plane did not complete the request (${err.message}).`)
    }
    throw new Error(`${name}: the control plane is not reachable right now — try again shortly.`)
  }
}

const SOURCE_REFUSALS: Record<Exclude<ArtifactSourceResult, { ok: true }>['reason'], (label: string) => string> = {
  sandboxed: () =>
    "publishArtifact: this agent's sandbox is not reachable right now, so its workspace cannot be read — try again shortly.",
  'not-found': (label) => `publishArtifact: no file or directory at "${label}" in this workspace or session files.`,
  escape: (label) =>
    `publishArtifact: "${label}" is neither a workspace-relative path nor a \`files:\` name — only the workspace and ` +
    "this session's files can be published, never `.git` or a path that leaves them."
}

const OUTPUT_REFUSALS: Record<Exclude<ArtifactOutputsResult, { ok: true }>['reason'], string> = {
  sandboxed: "fetchArtifact: this agent's sandbox is not reachable right now — try again shortly.",
  'no-workspace': 'fetchArtifact: this session has no files directory to download into.',
  escape: 'fetchArtifact: the session outputs directory is not a plain directory, so nothing was written.',
  'write-failed': 'fetchArtifact: writing into the session outputs directory failed'
}

/** Who can open the artifact now, in words the agent can repeat (artifacts.md §6, §7.2). */
export function whoCanOpen(audience: ArtifactAudienceSummary): string {
  const who =
    audience.visibility === 'private'
      ? audience.owned
        ? 'Only its owner, the person it was made for, can open it.'
        : 'Only organization owners can open it.'
      : audience.visibility === 'org'
        ? 'Every member of the organization can open it.'
        : audience.visibility === 'external'
          ? `Organization members who can see the ${
              audience.externalProvider ? platformLabel(audience.externalProvider) : 'chat'
            } conversation it came from can open it.`
          : 'People who can edit this agent can open it.'
  return audience.owned || audience.visibility === 'private'
    ? who
    : `${who} It has no owner, so organization owners manage it.`
}

const PUT_CONCURRENCY = 4
const CARDS_KEPT = 512

async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  })
  await Promise.all(lanes)
}

const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Re-read each file, prove it is the bytes the manifest named, and PUT it; one retry for a dropped connection. */
async function uploadAll(
  tree: ArtifactSourceTree,
  files: ArtifactSourceFile[],
  uploads: { path: string; url: string; headers: Record<string, string> }[],
  port: ArtifactPort
): Promise<void> {
  const byPath = new Map(uploads.map((upload) => [upload.path, upload]))
  await eachLimited(files, PUT_CONCURRENCY, async (file) => {
    const upload = byPath.get(file.path)
    if (!upload)
      throw new Error(`publishArtifact: the control plane signed no upload for "${file.path}" — publish again.`)
    const read = await tree.read(file.rel, file.bytes)
    if (!read || !('bytes' in read) || sha256Hex(read.bytes) !== file.sha256)
      throw new ArtifactToolError(
        `publishArtifact: "${file.path}" changed while it was being published — publish again once it is final.`
      )
    for (let attempt = 1; ; attempt++) {
      try {
        await port.put(upload, read.bytes)
        return
      } catch (err) {
        if (attempt < 2 && err instanceof PutObjectError && err.reason === 'upload-failed') continue
        throw new Error(
          `publishArtifact: uploading "${file.path}" failed (${err instanceof Error ? err.message : String(err)}); nothing was published. Publish again.`
        )
      }
    }
  })
}

/** Mark a card as written, keeping the set bounded; false when this process already wrote it. */
function firstCard(cards: Set<string>, key: string): boolean {
  if (cards.has(key)) return false
  cards.add(key)
  if (cards.size > CARDS_KEPT) cards.delete(cards.values().next().value!)
  return true
}

export const publishArtifact: ToolHandler<ArtifactToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(PUBLISH_ARTIFACT_ARGS, args)
  const port = portFor(ctx, deps, 'publishArtifact')
  if (!a.artifactId && !a.title)
    throw new Error(
      'publishArtifact: a new artifact needs a `title`. To publish a new revision of one you published, pass its `artifactId`.'
    )
  const turn = await turnFor(ctx, port, 'publishArtifact')
  const label = await port.normalizePath(ctx, a.path).catch(() => a.path)
  const source = await port.source(ctx, a.path)
  if (!source.ok) throw new Error(SOURCE_REFUSALS[source.reason](label))

  let built
  try {
    built = await buildArtifactManifest(source.tree, {
      label,
      ...(a.entry !== undefined ? { entry: a.entry } : {}),
      maxFileBytes: port.maxFileBytes()
    })
  } catch (err) {
    if (err instanceof ArtifactToolError) throw err
    throw new Error(
      `publishArtifact: "${label}" could not be read (${err instanceof Error ? err.message : String(err)}).`
    )
  }

  const creating = a.artifactId === undefined
  const begun = await cp('publishArtifact', () =>
    port.begin({
      agentId: ctx.agentId,
      sessionId: turn.sessionId,
      ...(a.artifactId ? { artifactId: a.artifactId } : {}),
      ...(creating && a.title ? { title: a.title } : {}),
      manifest: built.manifest,
      idempotencyKey: artifactIdempotencyKey({
        agentId: ctx.agentId,
        sessionId: turn.sessionId,
        turn: turn.turn,
        ...(a.artifactId ? { artifactId: a.artifactId } : {}),
        ...(creating && a.title ? { title: a.title } : {}),
        manifest: built.manifest
      }),
      network: port.network(),
      ...(turn.initiator ? { initiator: turn.initiator } : {})
    })
  )

  let published: ArtifactPublished
  if (begun.state === 'ready') {
    const { state: _state, ...ready } = begun
    published = ready
  } else {
    await uploadAll(source.tree, built.files, begun.uploads, port)
    published = await cp('publishArtifact', () =>
      port.complete({ agentId: ctx.agentId, artifactId: begun.artifactId, revision: begun.revision })
    )
  }

  const notices: string[] = []
  if (!creating && a.title !== undefined && a.title !== published.title)
    notices.push(`A new revision keeps the artifact’s title "${published.title}"; only people rename it.`)
  if (built.skipped.length) notices.push(`Left out: ${built.skipped.join(', ')}.`)
  const cardKey = `${turn.sessionId}\u001f${published.artifactId}\u001f${published.revision}`
  if (firstCard(port.cards, cardKey)) {
    const text = formatArtifactMarker({
      artifactId: published.artifactId,
      revision: published.revision,
      title: published.title
    })
    try {
      const recorded = await port.recordCard(ctx, text)
      if (recorded?.notice) notices.push(recorded.notice)
    } catch {
      port.cards.delete(cardKey)
      notices.push('The artifact was published, but its card could not be added to this conversation; the link works.')
    }
  }

  return {
    artifactId: published.artifactId,
    revision: published.revision,
    title: published.title,
    link: published.link ?? published.linkPath,
    audience: published.audience,
    whoCanOpen: whoCanOpen(published.audience),
    entry: built.manifest.entry,
    files: built.files.length,
    bytes: built.files.reduce((sum, f) => sum + f.bytes, 0),
    ...(notices.length ? { notice: notices.join(' ') } : {})
  }
}

export const fetchArtifact: ToolHandler<ArtifactToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(FETCH_ARTIFACT_ARGS, args)
  const port = portFor(ctx, deps, 'fetchArtifact')
  const turn = await turnFor(ctx, port, 'fetchArtifact')
  const got = await cp('fetchArtifact', () =>
    port.fetch({
      agentId: ctx.agentId,
      sessionId: turn.sessionId,
      artifactId: a.artifactId,
      ...(a.revision !== undefined ? { revision: a.revision } : {}),
      network: port.network()
    })
  )
  const urls = new Map(got.downloads.map((d) => [d.path, d.url]))
  for (const file of got.manifest.files) {
    if (artifactPathProblem(file.path) || !urls.has(file.path))
      throw new Error(`fetchArtifact: the control plane answered an unusable file list for this revision.`)
  }
  const written = await port.writeOutputs(ctx, artifactDirName(got.title, got.artifactId), async (put) => {
    for (const file of got.manifest.files) {
      let bytes: Buffer
      try {
        bytes = await port.download(urls.get(file.path)!, file.bytes)
      } catch (err) {
        throw new ArtifactToolError(
          `fetchArtifact: downloading "${file.path}" failed (${err instanceof Error ? err.message : String(err)}); nothing was replaced. Try again.`
        )
      }
      if (bytes.byteLength !== file.bytes || sha256Hex(bytes) !== file.sha256)
        throw new ArtifactToolError(
          `fetchArtifact: "${file.path}" did not match its recorded size and checksum; nothing was replaced. Try again.`
        )
      await put(file.path, bytes)
    }
  })
  if (!written.ok)
    throw new Error(
      written.reason === 'write-failed' && written.detail
        ? `${OUTPUT_REFUSALS['write-failed']} (${written.detail}).`
        : OUTPUT_REFUSALS[written.reason]
    )
  return {
    artifactId: got.artifactId,
    revision: got.revision,
    title: got.title,
    path: written.name,
    entry: `${written.name}/${got.manifest.entry}`,
    files: got.manifest.files.length
  }
}

export const listArtifacts: ToolHandler<ArtifactToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(LIST_ARTIFACTS_ARGS, args)
  const port = portFor(ctx, deps, 'listArtifacts')
  const turn = await turnFor(ctx, port, 'listArtifacts')
  const page = await cp('listArtifacts', () =>
    port.list({ agentId: ctx.agentId, sessionId: turn.sessionId, ...(a.cursor ? { cursor: a.cursor } : {}) })
  )
  return {
    artifacts: page.artifacts.map((item) => ({
      artifactId: item.artifactId,
      title: item.title,
      revision: item.latest.revision,
      entry: item.latest.entry,
      mediaType: item.latest.entryMediaType,
      files: item.latest.fileCount,
      bytes: item.latest.totalBytes,
      visibility: item.audience.visibility,
      canRevise: item.producedByAgent,
      updatedAt: item.updatedAt,
      ...(item.shares ? { shares: item.shares } : {})
    })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
  }
}

/** Who a share link admits, in words the agent can repeat (artifacts.md §8.3). */
export function whoCanOpenShare(audience: ArtifactShareAudience): string {
  return audience === 'public'
    ? 'Anyone who has the link can open this revision without signing in. Copies already downloaded cannot be recalled, even after the link is revoked.'
    : 'Signed-in members of the organization who have the link can open this revision.'
}

export const shareArtifact: ToolHandler<ArtifactToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(SHARE_ARTIFACT_ARGS, args)
  const port = portFor(ctx, deps, 'shareArtifact', 'shares')
  const turn = await turnFor(ctx, port, 'shareArtifact')
  const shared = await cp('shareArtifact', () =>
    port.share({
      agentId: ctx.agentId,
      sessionId: turn.sessionId,
      artifactId: a.artifactId,
      ...(a.revision !== undefined ? { revision: a.revision } : {}),
      audience: a.audience,
      ...(turn.initiator ? { initiator: turn.initiator } : {})
    })
  )
  return {
    shareId: shared.shareId,
    artifactId: shared.artifactId,
    revision: shared.revision,
    audience: shared.audience,
    link: shared.link ?? shared.linkPath,
    displayTail: shared.displayTail,
    whoCanOpen: whoCanOpenShare(shared.audience)
  }
}

export const unshareArtifact: ToolHandler<ArtifactToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(UNSHARE_ARTIFACT_ARGS, args)
  const port = portFor(ctx, deps, 'unshareArtifact', 'shares')
  const turn = await turnFor(ctx, port, 'unshareArtifact')
  const revoked = await cp('unshareArtifact', () =>
    port.unshare({
      agentId: ctx.agentId,
      sessionId: turn.sessionId,
      artifactId: a.artifactId,
      shareId: a.shareId,
      ...(turn.initiator ? { initiator: turn.initiator } : {})
    })
  )
  return {
    shareId: revoked.shareId,
    artifactId: revoked.artifactId,
    revision: revoked.revision,
    audience: revoked.audience,
    revokedAt: revoked.revokedAt,
    notice: 'The link no longer opens. Copies already downloaded are not recalled.'
  }
}

export const deleteArtifact: ToolHandler<ArtifactToolDeps> = async (ctx, args, deps) => {
  const a = parseArgs(DELETE_ARTIFACT_ARGS, args)
  const port = portFor(ctx, deps, 'deleteArtifact', 'delete')
  const turn = await turnFor(ctx, port, 'deleteArtifact')
  const deleted = await cp('deleteArtifact', () =>
    port.delete({
      agentId: ctx.agentId,
      sessionId: turn.sessionId,
      artifactId: a.artifactId,
      ...(turn.initiator ? { initiator: turn.initiator } : {})
    })
  )
  return {
    artifactId: deleted.artifactId,
    title: deleted.title,
    deletedAt: deleted.deletedAt,
    notice:
      'The artifact, every revision and every share link are gone; its links no longer open. Copies already downloaded are not recalled.'
  }
}

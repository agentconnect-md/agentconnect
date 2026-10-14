import type {
  AnyFrame,
  WorkspaceDeleteReq,
  WorkspaceGitCommitReq,
  WorkspaceGitDiffReq,
  WorkspaceGitLogReq,
  WorkspaceGitMessageReq,
  WorkspaceGitMessageResult,
  WorkspaceGitPullReq,
  WorkspaceGitPushReq,
  WorkspaceGitStageReq,
  WorkspaceGitStatusReq,
  WorkspaceListReq,
  WorkspaceMkdirReq,
  WorkspaceReadReq,
  WorkspaceUploadOk,
  WorkspaceUploadReq,
  WorkspaceWriteReq,
  TransferNetwork,
  TransferSettleOk,
  TransferSettleReq,
  TransferSignOk,
  TransferSignReq,
  TransferUploadOutcome
} from '@agentconnect.md/protocol'
import type { WorkspaceGit } from '../workspace-git.js'
import { WorkspaceConflictError, WorkspaceViolationError, type WorkspaceReader } from '../workspace-reader.js'
import type { ControlHandler, ControlWire } from './context.js'

/** The two live workspace seams — bytes stay daemon-local; never log payload/reply bodies. */
export interface WorkspaceReadDeps {
  /** Live workspace file seam over the agents' workspace dirs (§1/§12). */
  workspaceRead: WorkspaceReader
  /** Git status/pull seam over the agents' git-repo workspace dirs (§1/§12). */
  workspaceGit: WorkspaceGit
  /** `transfer/sign` to the control plane, which signs every transfer URL (source-cache-file-transfer.md §5). */
  signTransfer?: (req: TransferSignReq, orgId?: string) => Promise<TransferSignOk>
  /** `transfer/settle`: report a begun upload's outcome to the control plane. */
  settleTransfer?: (req: TransferSettleReq, orgId?: string) => Promise<TransferSettleOk>
  /** Where this daemon's snapshots reach the bucket from: its sandbox pods in the cluster, or the public origin. */
  transferNetwork?: TransferNetwork
}

export interface WorkspaceControlDeps extends WorkspaceReadDeps {
  gitMessagePasses: GitMessagePasses
  uploadBegins: UploadBegins
}

/**
 * In-flight commit-message passes by REQ id, and the only frame that needs them: the correlator
 * re-sends the IDENTICAL bytes (same id) when a REP is slow, and a model pass is always slower than
 * one ack window. Without joining, one press could run — and bill — several passes.
 */
export class GitMessagePasses {
  private readonly inflight = new Map<string, Promise<WorkspaceGitMessageResult>>()

  join(requestId: string, start: () => Promise<WorkspaceGitMessageResult>): Promise<WorkspaceGitMessageResult> {
    const existing = this.inflight.get(requestId)
    if (existing) return existing
    const pass = start().finally(() => this.inflight.delete(requestId))
    this.inflight.set(requestId, pass)
    return pass
  }
}

export const workspaceList: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Read-only live pull — bytes stay daemon-local; never log payload/reply bodies.
  deps.workspaceRead
    .list(frame.payload as WorkspaceListReq)
    .then((page) => wire.reply(frame, 'workspace/list/page', page))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/list', err))
}

export const workspaceRead: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.workspaceRead
    .read(frame.payload as WorkspaceReadReq)
    .then((content) => wire.reply(frame, 'workspace/read/content', content))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/read', err))
}

export const workspaceWrite: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Console manager edit: bounded scratch text create/replace; never log content.
  deps.workspaceRead
    .write(frame.payload as WorkspaceWriteReq)
    .then((ok) => wire.reply(frame, 'workspace/write/ok', ok))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/write', err))
}

export const workspaceDelete: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Console manager delete: scratch-only and mtime-fenced like replacement.
  deps.workspaceRead
    .delete(frame.payload as WorkspaceDeleteReq)
    .then((ok) => wire.reply(frame, 'workspace/delete/ok', ok))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/delete', err))
}

export const workspaceMkdir: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Console manager folder create: scratch-only, and an existing path is a conflict.
  deps.workspaceRead
    .mkdir(frame.payload as WorkspaceMkdirReq)
    .then((ok) => wire.reply(frame, 'workspace/mkdir/ok', ok))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/mkdir', err))
}

/** One snapshot upload may stage and send up to the transfer cap, so it gets far longer than a file read. */
const WORKSPACE_UPLOAD_TIMEOUT_MS = 15 * 60_000

/** Snapshot one workspace file and PUT it on the URL the control plane signs for `req.ticket`. */
function runUpload(
  req: WorkspaceUploadReq,
  signTransfer: NonNullable<WorkspaceReadDeps['signTransfer']>,
  deps: WorkspaceReadDeps,
  orgId: string | undefined
): Promise<WorkspaceUploadOk> {
  const network = deps.transferNetwork ?? 'public'
  return deps.workspaceRead.upload(
    {
      agentId: req.agentId,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.repo ? { repo: req.repo } : {}),
      path: req.path,
      maxBytes: req.maxBytes,
      timeoutMs: WORKSPACE_UPLOAD_TIMEOUT_MS,
      revision: req.revision
    },
    async (file) => {
      try {
        return await signTransfer({ ticket: req.ticket, ...file, network }, orgId)
      } catch (err) {
        // The control plane refuses a snapshot that is not the revision it asked for as a conflict.
        if ((err as { code?: string } | null)?.code === 'CONFLICT')
          throw new WorkspaceConflictError('the file changed while it was copied; retry')
        throw new WorkspaceViolationError('the control plane did not sign the upload', 'transfer-failed')
      }
    }
  )
}

const noSigner = () =>
  new WorkspaceViolationError('this daemon cannot reach the control plane signer', 'transfer-unavailable')

export const workspaceUpload: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // The bytes go root → bucket on a URL the control plane signs for this ticket; they never ride this socket.
  const req = frame.payload as WorkspaceUploadReq
  const signTransfer = deps.signTransfer
  if (!signTransfer) return workspaceError(wire, frame.id, 'workspace/upload', noSigner())
  runUpload(req, signTransfer, deps, frame.orgId)
    .then((sent) => wire.reply(frame, 'workspace/upload/ok', sent))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/upload', err))
}

/** Waits before each `transfer/settle` attempt; the control plane's poll also finds a settled upload in the bucket. */
const SETTLE_RETRY_MS = [0, 2_000, 10_000, 30_000, 60_000, 120_000] as const

/** Begun uploads by ticket, so a re-sent `workspace/upload/begin` joins the one already running. */
export class UploadBegins {
  private readonly running = new Set<string>()

  constructor(private readonly settleRetryMs: readonly number[] = SETTLE_RETRY_MS) {}

  /** Run `upload` once per ticket and report its outcome through `settle`; false ⇒ that ticket is already running. */
  start(
    ticket: string,
    upload: () => Promise<WorkspaceUploadOk>,
    settle: (outcome: TransferUploadOutcome) => Promise<unknown>,
    log: ControlWire['log']
  ): boolean {
    if (this.running.has(ticket)) return false
    this.running.add(ticket)
    void upload()
      .then(
        (sent): TransferUploadOutcome => ({ ok: true, ...sent }),
        (err: unknown) => uploadFailure(err, log)
      )
      .then((outcome) => this.deliver(outcome, settle, log))
      .finally(() => this.running.delete(ticket))
    return true
  }

  private async deliver(
    outcome: TransferUploadOutcome,
    settle: (outcome: TransferUploadOutcome) => Promise<unknown>,
    log: ControlWire['log']
  ): Promise<void> {
    for (const wait of this.settleRetryMs) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref?.())
      try {
        await settle(outcome)
        return
      } catch {
        // Disconnected or refused: try again, as a reconnect may land on another control plane.
      }
    }
    log.warn('cp: workspace/upload/begin could not report its outcome; the ticket will expire')
  }
}

/** A begun upload's failure as `workspaceError` would have sent it: typed reasons pass through, anything else is generic. */
function uploadFailure(err: unknown, log: ControlWire['log']): TransferUploadOutcome {
  const message = (text: string) => `workspace/upload failed: ${text}`.slice(0, 500)
  if (err instanceof WorkspaceConflictError)
    return { ok: false, code: 'CONFLICT', reason: err.reason, message: message(err.message) }
  if (err instanceof WorkspaceViolationError)
    return { ok: false, code: 'BAD_PAYLOAD', reason: err.reason, message: message(err.message) }
  log.warn(`cp: workspace/upload failed: ${(err as Error)?.message}`)
  return { ok: false, code: 'INTERNAL', message: 'workspace/upload failed' }
}

export const workspaceUploadBegin: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Acknowledged at once: the upload runs on, and `transfer/settle` reaches whichever control plane holds the socket then.
  const req = frame.payload as WorkspaceUploadReq
  const { signTransfer, settleTransfer } = deps
  if (!signTransfer || !settleTransfer) return workspaceError(wire, frame.id, 'workspace/upload/begin', noSigner())
  deps.uploadBegins.start(
    req.ticket,
    () => runUpload(req, signTransfer, deps, frame.orgId),
    (outcome) => settleTransfer({ ticket: req.ticket, outcome }, frame.orgId),
    wire.log
  )
  wire.reply(frame, 'workspace/upload/begin/ok', {})
}

export const workspaceGitStatus: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // git status of a git-repo workspace — a dirty tree / non-repo is DATA, not an error.
  const req = frame.payload as WorkspaceGitStatusReq
  deps.workspaceGit
    .status(req.agentId, req.sessionId, req.repo)
    .then((status) => wire.reply(frame, 'workspace/gitstatus/result', status))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitstatus', err))
}

export const workspaceGitDiff: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Unified diff for one path — binary / unchanged / non-repo all come back as a result.
  deps.workspaceGit
    .diff(frame.payload as WorkspaceGitDiffReq)
    .then((result) => wire.reply(frame, 'workspace/gitdiff/result', result))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitdiff', err))
}

export const workspaceGitLog: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Newest commits of the checked-out branch; an empty repo is a result, not an error.
  deps.workspaceGit
    .log(frame.payload as WorkspaceGitLogReq)
    .then((result) => wire.reply(frame, 'workspace/gitlog/result', result))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitlog', err))
}

export const workspaceGitPull: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // On-demand ff-only pull — a failed pull comes back as a result (ok:false), not an error.
  deps.workspaceGit
    .pull((frame.payload as WorkspaceGitPullReq).agentId, (frame.payload as WorkspaceGitPullReq).repo)
    .then((result) => wire.reply(frame, 'workspace/gitpull/result', result))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitpull', err))
}

export const workspaceGitStage: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Console staging — the REP is the FRESH status, so the panel never re-polls its own action.
  deps.workspaceGit
    .stage(frame.payload as WorkspaceGitStageReq)
    .then((status) => wire.reply(frame, 'workspace/gitstage/result', status))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitstage', err))
}

export const workspaceGitUnstage: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.workspaceGit
    .unstage(frame.payload as WorkspaceGitStageReq)
    .then((status) => wire.reply(frame, 'workspace/gitunstage/result', status))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitunstage', err))
}

export const workspaceGitCommit: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Nothing staged / no registered identity / a git refusal are all results, not errors.
  deps.workspaceGit
    .commit(frame.payload as WorkspaceGitCommitReq)
    .then((result) => wire.reply(frame, 'workspace/gitcommit/result', result))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitcommit', err))
}

export const workspaceGitPush: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // A diverged branch, no upstream, a detached HEAD and a remote rejection are all results.
  deps.workspaceGit
    .push(frame.payload as WorkspaceGitPushReq)
    .then((result) => wire.reply(frame, 'workspace/gitpush/result', result))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitpush', err))
}

export const workspaceGitMessage: ControlHandler<WorkspaceControlDeps> = (frame: AnyFrame, deps, wire) => {
  // The AI commit-message draft: a bounded model turn on THIS daemon's runtime. Nothing staged,
  // a runtime that declines and a timeout are all results, not errors. Retransmit-joined
  // ({@link GitMessagePasses}) so a re-sent REQ rides the pass it already started.
  deps.gitMessagePasses
    .join(frame.id, () => deps.workspaceGit.message(frame.payload as WorkspaceGitMessageReq))
    .then((result) => wire.reply(frame, 'workspace/gitmessage/result', result))
    .catch((err) => workspaceError(wire, frame.id, 'workspace/gitmessage', err))
}

/** Map a workspace failure onto the wire: stale writes → CONFLICT; containment/
 *  bad-request violations → BAD_PAYLOAD (their messages are hand-written and
 *  path-free); anything else → INTERNAL with a GENERIC message — raw fs errors
 *  (ELOOP, EACCES, …) embed absolute host paths that must not leak to the CP/UI.
 *  Both typed cases carry their `reason` in `details` so the CP can answer a bad
 *  request with a status the console can tell apart from an offline daemon. */
export function workspaceError(wire: ControlWire, corr: string, op: string, err: unknown): void {
  if (err instanceof WorkspaceConflictError) {
    wire.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  if (err instanceof WorkspaceViolationError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  wire.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', `${op} failed`, false)
}

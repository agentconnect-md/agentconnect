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
  WorkspaceReadReq,
  WorkspaceWriteReq
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
}

export interface WorkspaceControlDeps extends WorkspaceReadDeps {
  gitMessagePasses: GitMessagePasses
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

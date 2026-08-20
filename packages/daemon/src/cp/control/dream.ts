import type {
  AnyFrame,
  DreamAdoptReq,
  DreamCancelReq,
  DreamDiscardReq,
  DreamFileReadReq,
  DreamFilesReq,
  DreamGetReq,
  DreamListReq,
  DreamSkillReadReq,
  DreamSkillReviewReq,
  DreamStartReq,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionReviewReq
} from '@agentconnect.md/protocol'
import { DreamStateError, DreamViolationError } from '../../dream/runner.js'
import type { DreamReader } from '../dream-reader.js'
import { MemorySandboxUnavailableError } from '../memory-reader.js'
import type { ControlHandler, ControlWire } from './context.js'

export interface DreamControlDeps {
  /** Dream-job lifecycle + staged-output review seam (docs/designs/memory-dreaming.md §10). */
  dreamReader: DreamReader
}

// ── memory dreaming — job metadata + staged-body review (bodies stay daemon-local) ──

export const dreamStart: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .start(frame.payload as DreamStartReq)
    .then((state) => wire.reply(frame, 'memory/dream/start/ok', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/start', err))
}

export const dreamCancel: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .cancel(frame.payload as DreamCancelReq)
    .then((state) => wire.reply(frame, 'memory/dream/cancel/ok', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/cancel', err))
}

export const dreamList: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .list(frame.payload as DreamListReq)
    .then((page) => wire.reply(frame, 'memory/dream/list/page', page))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/list', err))
}

export const dreamGet: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .get(frame.payload as DreamGetReq)
    .then((state) => wire.reply(frame, 'memory/dream/get/result', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/get', err))
}

export const dreamAdopt: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .adopt(frame.payload as DreamAdoptReq)
    .then((state) => wire.reply(frame, 'memory/dream/adopt/ok', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/adopt', err))
}

export const dreamDiscard: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .discard(frame.payload as DreamDiscardReq)
    .then((state) => wire.reply(frame, 'memory/dream/discard/ok', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/discard', err))
}

export const dreamFiles: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .files(frame.payload as DreamFilesReq)
    .then((page) => wire.reply(frame, 'memory/dream/files/page', page))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/files', err))
}

export const dreamFileRead: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .fileRead(frame.payload as DreamFileReadReq)
    .then((content) => wire.reply(frame, 'memory/dream/file/read/content', content))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/file/read', err))
}

export const dreamSkillRead: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  const req = frame.payload as DreamSkillReadReq
  deps.dreamReader
    .skillRead(req)
    .then((content) => wire.reply(frame, 'memory/dream/skill/read/ok', content))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/skill/read', err))
}

export const dreamSkillAccept: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .skillAccept(frame.payload as DreamSkillReviewReq)
    .then((state) => wire.reply(frame, 'memory/dream/skill/accept/ok', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/skill/accept', err))
}

export const dreamSkillDismiss: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .skillDismiss(frame.payload as DreamSkillReviewReq)
    .then((state) => wire.reply(frame, 'memory/dream/skill/dismiss/ok', state))
    .catch((err) => dreamError(wire, frame.id, 'memory/dream/skill/dismiss', err))
}

export const knowledgeSuggestionRead: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .organizationSuggestionRead(frame.payload as OrganizationSuggestionReadReq)
    .then((content) => wire.reply(frame, 'knowledge/suggestion/content', content))
    .catch((err) => dreamError(wire, frame.id, 'knowledge/suggestion/read', err))
}

export const knowledgeSuggestionReview: ControlHandler<DreamControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.dreamReader
    .organizationSuggestionReview(frame.payload as OrganizationSuggestionReviewReq)
    .then((ack) => wire.reply(frame, 'ack', ack))
    .catch((err) => dreamError(wire, frame.id, 'knowledge/suggestion/review', err))
}

/** Unknown agent/dream/path → BAD_PAYLOAD; a legal request against the wrong
 *  lifecycle state → CONFLICT; anything else → INTERNAL with a generic message
 *  (raw fs errors embed absolute host paths that must not leak to the CP/UI). */
function dreamError(wire: ControlWire, corr: string, op: string, err: unknown): void {
  if (err instanceof DreamViolationError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false)
    return
  }
  // A cluster agent's staging is on its sandbox volume: asleep is transient, and carries the reason.
  if (err instanceof MemorySandboxUnavailableError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  if (err instanceof DreamStateError) {
    wire.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false)
    return
  }
  wire.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', `${op} failed`, false)
}

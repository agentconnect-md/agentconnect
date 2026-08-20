import type {
  AnyFrame,
  MemoryChannelsReq,
  MemoryHistoryReq,
  MemoryListReq,
  MemoryReadReq,
  MemoryRecordCreateReq,
  MemoryRecordDeleteReq,
  MemoryRecordGetReq,
  MemoryRecordHistoryReq,
  MemoryRecordListReq,
  MemoryRecordSearchReq,
  MemoryRecordUpdateReq,
  MemorySurfaceReq,
  MemoryWriteReq
} from '@agentconnect.md/protocol'
import {
  MemoryConflictError,
  MemoryPathError,
  MemorySandboxUnavailableError,
  MemoryTooLargeError,
  MemoryViolationError,
  type MemoryReader
} from '../memory-reader.js'
import type { ControlHandler, ControlWire } from './context.js'

export interface MemoryControlDeps {
  /** Read/write seam over the agents' memory dirs (`<agent-root>/memory/`, §1/§12). */
  memoryReader: MemoryReader
}

export const memoryChannels: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .channels(frame.payload as MemoryChannelsReq)
    .then((page) => wire.reply(frame, 'memory/channels/page', page))
    .catch((err) => memoryError(wire, frame.id, 'memory/channels', err))
}

export const memoryList: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .list(frame.payload as MemoryListReq)
    .then((page) => wire.reply(frame, 'memory/list/page', page))
    .catch((err) => memoryError(wire, frame.id, 'memory/list', err))
}

export const memoryRead: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Read-only live pull of an agent memory file — bytes stay daemon-local.
  deps.memoryReader
    .read(frame.payload as MemoryReadReq)
    .then((content) => wire.reply(frame, 'memory/read/content', content))
    .catch((err) => memoryError(wire, frame.id, 'memory/read', err))
}

export const memoryWrite: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Console edit: replace the whole memory file, reply with the new size/mtime.
  deps.memoryReader
    .write(frame.payload as MemoryWriteReq)
    .then((ok) => wire.reply(frame, 'memory/write/ok', ok))
    .catch((err) => memoryError(wire, frame.id, 'memory/write', err))
}

export const memoryHistory: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  // Managed provenance is paged separately so `.history` stays hidden from
  // ordinary file listing/reads and only bounded rows cross the wire.
  deps.memoryReader
    .history(frame.payload as MemoryHistoryReq)
    .then((page) => wire.reply(frame, 'memory/history/page', page))
    .catch((err) => memoryError(wire, frame.id, 'memory/history', err))
}

export const memorySurface: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .surface(frame.payload as MemorySurfaceReq)
    .then((info) => wire.reply(frame, 'memory/surface/info', info))
    .catch((err) => memoryError(wire, frame.id, 'memory/surface', err))
}

export const memoryRecordSearch: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .search(frame.payload as MemoryRecordSearchReq)
    .then((page) => wire.reply(frame, 'memory/record/search/page', page))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/search', err))
}

export const memoryRecordList: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .recordList(frame.payload as MemoryRecordListReq)
    .then((page) => wire.reply(frame, 'memory/record/list/page', page))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/list', err))
}

export const memoryRecordGet: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .recordGet(frame.payload as MemoryRecordGetReq)
    .then((result) => wire.reply(frame, 'memory/record/get/result', result))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/get', err))
}

export const memoryRecordCreate: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .recordCreate(frame.payload as MemoryRecordCreateReq)
    .then((result) => wire.reply(frame, 'memory/record/create/result', result))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/create', err))
}

export const memoryRecordUpdate: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .recordUpdate(frame.payload as MemoryRecordUpdateReq)
    .then((result) => wire.reply(frame, 'memory/record/update/result', result))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/update', err))
}

export const memoryRecordDelete: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .recordDelete(frame.payload as MemoryRecordDeleteReq)
    .then((result) => wire.reply(frame, 'memory/record/delete/result', result))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/delete', err))
}

export const memoryRecordHistory: ControlHandler<MemoryControlDeps> = (frame: AnyFrame, deps, wire) => {
  deps.memoryReader
    .recordHistory(frame.payload as MemoryRecordHistoryReq)
    .then((page) => wire.reply(frame, 'memory/record/history/page', page))
    .catch((err) => memoryError(wire, frame.id, 'memory/record/history', err))
}

function memoryError(wire: ControlWire, corr: string, op: string, err: unknown): void {
  if (err instanceof MemoryConflictError) {
    wire.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false)
    return
  }
  // The memory tree is on a sandbox that is not running: refused with the workspace reader's
  // reason, so the CP answers 503 with the code the console wakes on (#1077) — not a 400.
  if (err instanceof MemorySandboxUnavailableError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
    return
  }
  if (err instanceof MemoryViolationError || err instanceof MemoryPathError || err instanceof MemoryTooLargeError) {
    wire.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false)
    return
  }
  wire.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
  wire.sendError(corr, 'INTERNAL', `${op} failed`, false)
}

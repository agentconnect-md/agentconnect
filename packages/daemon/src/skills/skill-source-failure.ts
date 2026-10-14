// Per-Source skill failure codes the daemon reports to the CP (source-cache.md §11): names and codes only, never raw output.
import { MAX_AGENT_SKILL_STATUS_SOURCES, type SkillSourceFailureCode } from '@agentconnect.md/protocol'
import { SkillSourceSnapshotError } from './skill-source-snapshot.js'

/** A Git skill Source failure tagged with its §11 reason code. */
export class SkillSourceFailure extends Error {
  constructor(
    readonly code: SkillSourceFailureCode,
    message: string
  ) {
    super(message)
    this.name = 'SkillSourceFailure'
  }
}

/** One configured Source a completed reconcile could not install. */
export interface SkillSourceFailureEntry {
  name: string
  code: SkillSourceFailureCode
}

/** The code an acquisition or install error carries; an untagged one is `fallback`. */
export function skillSourceFailureCode(
  error: unknown,
  fallback: SkillSourceFailureCode = 'fetch_failed'
): SkillSourceFailureCode {
  if (error instanceof SkillSourceFailure) return error.code
  if (error instanceof SkillSourceSnapshotError) return 'limits_exceeded'
  return fallback
}

/** An HTTP refusal of a host read: authentication and authorization statuses are `access_denied`. */
export function httpFailureCode(status: number, otherwise: SkillSourceFailureCode): SkillSourceFailureCode {
  return status === 401 || status === 403 ? 'access_denied' : otherwise
}

/** A host read's refusal as a tagged failure, with the status only in the message. */
export function httpSkillFailure(
  status: number,
  otherwise: SkillSourceFailureCode,
  message: string
): SkillSourceFailure {
  return new SkillSourceFailure(httpFailureCode(status, otherwise), message)
}

/** First failure per Source name, in report order, capped at the wire's bound. */
export function uniqueSkillSourceFailures(entries: Iterable<SkillSourceFailureEntry>): SkillSourceFailureEntry[] {
  const byName = new Map<string, SkillSourceFailureEntry>()
  for (const entry of entries) if (!byName.has(entry.name)) byName.set(entry.name, entry)
  return [...byName.values()].slice(0, MAX_AGENT_SKILL_STATUS_SOURCES)
}

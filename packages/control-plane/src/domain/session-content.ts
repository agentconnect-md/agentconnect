/**
 * The ONE answer to "which daemons can serve this session's recorded content"
 * (transcript pages, tool bodies). Both content-read routes resolve their targets here.
 *
 * `SessionMeta.daemonId` names the daemon that FIRST reported the session, and for a
 * self-hosted daemon that is also the only machine holding the rows — its store is local.
 * A cluster pool member is different: its store is the install-wide data-plane Postgres
 * every member shares, so the content outlives the pod that recorded it. Pool members are
 * bound to a Pod UID and reaped 15 minutes after they go silent, which SetNulls `daemonId`
 * on every session they recorded — so routing by that column alone loses transcripts that
 * are still fully there.
 *
 * Eligibility is a property of the STORE, and of the SESSION, never of the agent:
 *
 * - Not of the agent's placement. It can move into a set, out of one, or between two long
 *   after a session ran; content does not follow it either way. `SessionMeta.contentSetId`
 *   is stamped from the recorder's own membership when the session is first reported, so it
 *   keeps naming the store the bodies went to however the agent is placed later.
 * - Not of the agent's live duty holder. An idle pooled agent holds no lease at all — the
 *   ordinary state — yet its transcripts are exactly as readable as ever, by any member of
 *   the store they were written to.
 */

/** Where a session's rows were written, and who still holds that store. */
export interface SessionContentSources {
  /** `SessionMeta.daemonId` — the recorder, null once a retired pool member SetNulled it. */
  recordedDaemonId: string | null
  /** Members of `SessionMeta.contentSetId`, and only where that set shares one content store. */
  sharedStoreMembers: readonly string[]
}

/**
 * Readers to try in order: the recorder first (always right when it is still connected),
 * then the other members of its store. Empty means the content has no reachable owner at
 * all — the caller's 503.
 *
 * Order matters and no caller may reorder it: a daemon that does not hold the session
 * answers `history` with an EMPTY page rather than an error, so a wrong pick reads as an
 * empty transcript, not as a failure to fall through. That is also why membership of the
 * shared store — not mere reachability — is what earns a daemon a place in this list.
 */
export function sessionContentReaders(sources: SessionContentSources): string[] {
  return [
    ...new Set([
      ...(sources.recordedDaemonId ? [sources.recordedDaemonId] : []),
      ...[...sources.sharedStoreMembers].sort()
    ])
  ]
}

/** May `daemonId` serve this session's content — the recorder itself, or a holder of the store it wrote to? */
export function servesSessionContent(sources: SessionContentSources, daemonId: string): boolean {
  return sessionContentReaders(sources).includes(daemonId)
}

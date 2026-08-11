'use client'

// The Git panel's commit box (§3.3, §5.1): a message, a wand that drafts one from the staged diff on the AGENT's own runtime, "Commit N files", and commit-and-push beside it.
// Every refusal here is DATA the reader can act on — nothing staged, a blank message, no registered commit identity, a diverged branch, a runtime that declines to write a message. The box reports them in place and keeps the draft, because a message a reader wrote (or paid a model for) must survive the answer.

import { useSyncExternalStore } from 'react'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { gitWriteFailureText, gitWriteRequestFailureText } from '@/components/console/dock/git-write'
import {
  ApiError,
  commitWorkspace,
  draftWorkspaceCommitMessage,
  pushWorkspace,
  type WorkspaceGitCommitResultDto,
  type WorkspaceGitPushResultDto
} from '@/lib/api'

const statusOf = (e: unknown) => (e instanceof ApiError ? e.status : null)
const codeOf = (e: unknown) => (e instanceof ApiError && e.code ? e.code : null)

/** The wire cap on one commit message (protocol's `MAX_WORKSPACE_COMMIT_MESSAGE`), restated here because the browser must refuse a longer one before the CP does — a 400 after a paid draft is a worse answer than a `maxLength`. */
const MAX_MESSAGE = 8_000

/** What is in flight. One at a time: the daemon serialises workspace writes anyway, and a second press while the first is queued would report the wrong outcome against the wrong draft. */
type Busy = 'draft' | 'commit' | 'push' | null

/** The last answer, kept until the next press. `ok` outcomes are as much data as refusals — "Everything is already pushed." is the whole answer to a push. */
interface Outcome {
  ok: boolean
  text: string
}

/**
 * Everything about one checkout that has to outlive this component: the draft, what is in flight,
 * and the last outcome. All three live HERE and nowhere else.
 *
 * The panel above unmounts the box while a newly selected scope's status settles, so any of these
 * held in component state is lost across `A → B → A` — and a request that resolves after the switch
 * calls the setter of an instance that no longer exists. Four review rounds found the same class of
 * bug three times, once per value, each time in a mechanism written to keep component state and a
 * module store in step. There is no second copy now, and the record's SHAPE is what keeps the next
 * per-checkout value from being added to the wrong place.
 *
 * Bounded, because a reader who visits many checkouts should not grow this without limit — but never
 * evicting a scope with a request in flight, whose outcome nothing else is holding.
 */
interface CommitScopeState {
  draft: string
  busy: Busy
  outcome: Outcome | null
}

const EMPTY_SCOPE: CommitScopeState = { draft: '', busy: null, outcome: null }
const COMMIT_SCOPES = new Map<string, CommitScopeState>()
const COMMIT_SCOPES_MAX = 20
const scopeListeners = new Set<() => void>()

function subscribeToScopes(listener: () => void): () => void {
  scopeListeners.add(listener)
  return () => scopeListeners.delete(listener)
}

/** One checkout's state. The same object identity while nothing about it changes, which is what
 *  `useSyncExternalStore` requires of a snapshot. */
function readScope(scope: string): CommitScopeState {
  return COMMIT_SCOPES.get(scope) ?? EMPTY_SCOPE
}

function writeScope(scope: string, patch: Partial<CommitScopeState>): void {
  const next = { ...readScope(scope), ...patch }
  if (next.draft === '' && next.busy === null && next.outcome === null) COMMIT_SCOPES.delete(scope)
  else {
    // Re-inserted so the map's own order is least-recently-written first.
    COMMIT_SCOPES.delete(scope)
    COMMIT_SCOPES.set(scope, next)
    for (const key of [...COMMIT_SCOPES.keys()]) {
      if (COMMIT_SCOPES.size <= COMMIT_SCOPES_MAX) break
      if (COMMIT_SCOPES.get(key)?.busy !== null) continue
      COMMIT_SCOPES.delete(key)
    }
  }
  for (const listener of scopeListeners) listener()
}

/** Forget every checkout. Module state outlives a test's render, so a suite that does not reset it
 *  would have cases reading each other's drafts. */
export function resetCommitDrafts(): void {
  COMMIT_SCOPES.clear()
  for (const listener of scopeListeners) listener()
}

export function CommitBox({
  agentId,
  sessionId,
  stagedCount,
  pushHint,
  onWrote
}: {
  agentId: string
  /** ACP session id selecting that session's isolated worktree; omit for the agent's primary checkout. */
  sessionId?: string
  /** How many paths the index currently holds, from the status the panel already read. `0` disables the commit — that is the "nothing staged" state, said before the round trip rather than after it. */
  stagedCount: number
  /** Why this checkout cannot be pushed at all, when the status already says so — a detached HEAD or a branch with no upstream are exactly the daemon's `detached-head` / `no-upstream` refusals, read from the same fields. Present ⇒ the push control is WITHHELD and this sentence takes its place; a commit still works. */
  pushHint?: string
  /** A commit or a push landed: the caller's status, log and tree reads are all stale now. Not called for a draft, which writes nothing. */
  onWrote: () => void
}) {
  // The draft lives ONLY in the module store, read here through `useSyncExternalStore`. It is per
  // checkout because a draft belongs to one, and it must never follow the reader into another agent's
  // workspace; and it outlives this component because the panel above unmounts the box while a newly
  // selected scope's status settles — the exact switch the draft has to survive.
  //
  // No second copy in component state, deliberately. Three earlier attempts kept state and the store
  // in step and each left a window open, the last being `A → B → A → resolve`: the remounted box read
  // the map before the answer landed, and the completion then wrote the map and called the setter of
  // an instance that no longer existed. With one source of truth there is nothing to fall out of step.
  const draftScope = `${agentId}\n${sessionId ?? ''}`
  const state = useSyncExternalStore(
    subscribeToScopes,
    () => readScope(draftScope),
    () => EMPTY_SCOPE
  )
  const { draft: message, busy, outcome } = state
  const setMessage = (text: string) => writeScope(draftScope, { draft: text })
  const scope = sessionId ? { sessionId } : {}

  const nothingStaged = stagedCount === 0
  const blank = message.trim() === ''

  // The wand (§5.1). Explicit, never automatic: the pass runs on the agent's runtime and costs its tokens, so nothing here prefetches a draft.
  const draft = async () => {
    if (readScope(draftScope).busy || nothingStaged) return
    // The checkout this request is FOR. A completion must never land on whichever scope happens to be
    // current when it returns, and the previous outcome is cleared SYNCHRONOUSLY so a stale refusal
    // cannot sit under a running spinner.
    const asked = draftScope
    writeScope(asked, { busy: 'draft', outcome: null })
    try {
      const rep = await draftWorkspaceCommitMessage(agentId, scope)
      // `ok:false` is the runtime's own answer — a prose reply, a decline, a budget it ran out of — so its `detail` is what the reader needs, not a generic failure.
      if (rep.ok && rep.message) {
        // Written for the scope it was ASKED for: the reader may have switched checkout while the
        // pass ran, and this box may be a different instance — or none.
        writeScope(asked, { draft: rep.message })
      } else writeScope(asked, { outcome: { ok: false, text: gitWriteFailureText(null, rep.detail) } })
    } catch (e) {
      writeScope(asked, { outcome: { ok: false, text: gitWriteRequestFailureText(statusOf(e), codeOf(e)) } })
    } finally {
      // Cleared for the scope the request was ISSUED for, which may no longer be the one on screen.
      writeScope(asked, { busy: null })
    }
  }

  const pushOutcome = (rep: WorkspaceGitPushResultDto): Outcome =>
    rep.ok
      ? { ok: true, text: rep.detail ?? 'Pushed.' }
      : { ok: false, text: gitWriteFailureText(rep.reason, rep.detail) }

  const commitOutcome = (rep: WorkspaceGitCommitResultDto): Outcome =>
    rep.ok
      ? { ok: true, text: rep.detail ?? `Committed ${(rep.sha ?? '').slice(0, 7)}.` }
      : { ok: false, text: gitWriteFailureText(rep.reason, rep.detail) }

  const commit = async (thenPush: boolean) => {
    if (readScope(draftScope).busy || nothingStaged || blank) return
    const asked = draftScope
    writeScope(asked, { busy: thenPush ? 'push' : 'commit', outcome: null })
    try {
      const rep = await commitWorkspace(agentId, { message, ...scope })
      if (!rep.ok) {
        writeScope(asked, { outcome: commitOutcome(rep) })
        return
      }
      // The draft is spent the moment it becomes a commit; keeping it would offer to commit the same
      // message twice — and for the scope the commit was made against, since the reader may have
      // switched away while it was in flight.
      writeScope(asked, { draft: '' })
      onWrote()
      if (!thenPush) {
        writeScope(asked, { outcome: commitOutcome(rep) })
        return
      }
      // Its own try, because past this point the COMMIT HAS LANDED. A push that throws — a transport
      // failure, a 5xx, an offline daemon — is not the same event as a commit that failed, and letting
      // it fall to the outer catch reported only the generic request failure: the reader was not told
      // their commit exists, which is the ambiguity the both-halves rule below is here to prevent.
      let pushText: string
      let pushOk = false
      try {
        const pushed = await pushWorkspace(agentId, scope)
        pushOk = pushed.ok
        pushText = pushOutcome(pushed).text
      } catch (e) {
        pushText = gitWriteRequestFailureText(statusOf(e), codeOf(e))
      }
      // Both halves, because the commit LANDED even when the push did not — a bare "diverged" would read as "nothing happened".
      writeScope(asked, { outcome: { ok: pushOk, text: `${commitOutcome(rep).text} ${pushText}` } })
      // Only a push that LANDED moved anything the caller reads (the pushed markers, the ahead count); a rejected one changed nothing, and re-reading for it would be a round trip that reports the same tree.
      if (pushOk) onWrote()
    } catch (e) {
      writeScope(asked, { outcome: { ok: false, text: gitWriteRequestFailureText(statusOf(e), codeOf(e)) } })
    } finally {
      // Cleared for the scope the request was ISSUED for, which may no longer be the one on screen.
      writeScope(asked, { busy: null })
    }
  }

  const commitLabel = nothingStaged ? 'Commit' : `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`

  return (
    <div data-commit-box="" className="flex flex-none flex-col gap-2 border-t border-(--border-subtle) px-3 py-[9px]">
      <div className="relative">
        <textarea
          data-commit-message=""
          value={message}
          maxLength={MAX_MESSAGE}
          onChange={(event) => setMessage(event.target.value)}
          disabled={busy === 'commit' || busy === 'push'}
          aria-label="Commit message"
          placeholder={nothingStaged ? 'Stage a file to commit it' : 'Commit message'}
          className="min-h-16 w-full resize-y rounded-md border border-(--border-subtle) bg-(--surface-sunken) py-2 pr-9 pl-[10px] font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-primary) outline-none focus:border-(--border-strong)"
        />
        {/* The wand rides the field's own corner, as the design draws it: it fills THIS box, and a button in the row below would read as a third commit action. */}
        <button
          type="button"
          data-commit-draft=""
          className="iconbtn absolute top-[5px] right-[5px] h-[26px] w-[26px] disabled:pointer-events-none disabled:opacity-50"
          disabled={busy !== null || nothingStaged}
          aria-label="Generate a commit message from the staged diff"
          title={
            nothingStaged
              ? 'Stage something first — the message is written from the staged diff'
              : 'Generate a commit message from the staged diff (runs on the agent’s own runtime and spends its tokens)'
          }
          onClick={() => void draft()}
        >
          {busy === 'draft' ? <Spinner size={13} /> : <Icon name="wand-sparkles" size={14} />}
        </button>
      </div>
      {/* The pending state the design asks for, in the box rather than as a toast: the pass is a model turn on the agent's runtime and takes seconds. */}
      {busy === 'draft' ? (
        <div
          data-commit-drafting=""
          className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          Generating from staged diff…
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-commit-submit=""
          className="dsbtn dsbtn-primary sm min-w-0 flex-1 disabled:pointer-events-none disabled:opacity-50"
          disabled={busy !== null || nothingStaged || blank}
          title={
            nothingStaged
              ? 'Nothing is staged'
              : blank
                ? 'Write a commit message first'
                : 'Commit the staged changes on the agent’s machine'
          }
          onClick={() => void commit(false)}
        >
          {busy === 'commit' ? <Spinner size={13} /> : <Icon name="git-commit-horizontal" size={14} />}
          <span className="truncate">{commitLabel}</span>
        </button>
        {/* Withheld rather than drawn to fail: the status already says this branch cannot be pushed, and the daemon would answer the press with exactly that. */}
        {pushHint ? null : (
          <button
            type="button"
            data-commit-push=""
            className="dsbtn dsbtn-secondary sm flex-none disabled:pointer-events-none disabled:opacity-50"
            disabled={busy !== null || nothingStaged || blank}
            aria-label="Commit and push"
            title="Commit, then push the branch to the remote the daemon authorizes"
            onClick={() => void commit(true)}
          >
            {busy === 'push' ? <Spinner size={13} /> : <Icon name="arrow-up-from-line" size={14} />}
            <span>Push</span>
          </button>
        )}
      </div>
      {pushHint ? (
        <div
          data-commit-push-hint=""
          className="font-sans text-[11px] font-normal leading-[1.5] text-(--text-tertiary)"
        >
          {pushHint}
        </div>
      ) : null}
      {/* Whose name lands on the commit. Stated as the RULE rather than as a name: the identity the daemon registered is not on the wire to the console, and printing a guessed one beside a commit button would be the one place in this panel that invents its data. `no-identity` is how the reader learns there is none. */}
      <div
        data-commit-identity=""
        className="flex items-center gap-[5px] font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)"
        title="Console commits are attributed to the git identity the owning daemon registered at handshake, so a commit made here reads as the agent’s work — not as yours."
      >
        <Icon name="id-card" size={12} color="var(--text-tertiary)" className="flex-none" />
        <span className="truncate">Commits as the agent’s registered identity, not as you</span>
      </div>
      {outcome ? (
        <div
          data-commit-outcome={outcome.ok ? 'ok' : 'bad'}
          className={`flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-[1.5] ${outcome.ok ? 'text-(--text-secondary)' : 'text-(--red-600)'}`}
        >
          <Icon
            name={outcome.ok ? 'check' : 'triangle-alert'}
            size={13}
            color={outcome.ok ? 'var(--status-online)' : 'var(--red-600)'}
            className="mt-[2px] flex-none"
          />
          <span>{outcome.text}</span>
        </div>
      ) : null}
    </div>
  )
}

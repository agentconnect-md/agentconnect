'use client'

// The Git panel's commit box (§3.3, §5.1): a message, a wand that drafts one from the staged diff on the AGENT's own runtime, "Commit N files", and commit-and-push beside it.
// Every refusal here is DATA the reader can act on — nothing staged, a blank message, no registered commit identity, a diverged branch, a runtime that declines to write a message. The box reports them in place and keeps the draft, because a message a reader wrote (or paid a model for) must survive the answer.

import { useRef, useState } from 'react'
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
  // Drafts are kept PER SCOPE and restored on return. A draft belongs to one checkout, so it must
  // never follow the reader into another agent's workspace — but losing it outright means a reader
  // who glances at a sibling agent and comes back has silently paid for a model pass twice.
  const draftScope = `${agentId}\n${sessionId ?? ''}`
  const draftsRef = useRef(new Map<string, string>())
  const [scopeSeen, setScopeSeen] = useState(draftScope)
  const [message, setMessage] = useState(() => draftsRef.current.get(draftScope) ?? '')
  if (scopeSeen !== draftScope) {
    // Render-time so the box never paints one scope's draft under another's heading, the way the
    // viewer's own stale-paint hazard works. The outgoing draft is parked before the swap.
    draftsRef.current.set(scopeSeen, message)
    setScopeSeen(draftScope)
    setMessage(draftsRef.current.get(draftScope) ?? '')
  }
  const [busy, setBusy] = useState<Busy>(null)
  // The re-entry latch is a REF, not the `busy` state: two clicks dispatched in one task both read the same pre-update `busy` and the same not-yet-disabled button, so a double-click would bill two model passes and send two commits. Measured, not assumed.
  const running = useRef(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const scope = sessionId ? { sessionId } : {}

  const nothingStaged = stagedCount === 0
  const blank = message.trim() === ''

  // The wand (§5.1). Explicit, never automatic: the pass runs on the agent's runtime and costs its tokens, so nothing here prefetches a draft.
  const draft = async () => {
    if (running.current || nothingStaged) return
    running.current = true
    setBusy('draft')
    setOutcome(null)
    try {
      const rep = await draftWorkspaceCommitMessage(agentId, scope)
      // `ok:false` is the runtime's own answer — a prose reply, a decline, a budget it ran out of — so its `detail` is what the reader needs, not a generic failure.
      if (rep.ok && rep.message) setMessage(rep.message)
      else setOutcome({ ok: false, text: gitWriteFailureText(null, rep.detail) })
    } catch (e) {
      setOutcome({ ok: false, text: gitWriteRequestFailureText(statusOf(e), codeOf(e)) })
    } finally {
      running.current = false
      setBusy(null)
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
    if (running.current || nothingStaged || blank) return
    running.current = true
    setBusy(thenPush ? 'push' : 'commit')
    setOutcome(null)
    try {
      const rep = await commitWorkspace(agentId, { message, ...scope })
      if (!rep.ok) {
        setOutcome(commitOutcome(rep))
        return
      }
      // The draft is spent the moment it becomes a commit; keeping it would offer to commit the same message twice.
      setMessage('')
      onWrote()
      if (!thenPush) {
        setOutcome(commitOutcome(rep))
        return
      }
      const pushed = await pushWorkspace(agentId, scope)
      // Both halves, because the commit LANDED even when the push did not — a bare "diverged" would read as "nothing happened".
      setOutcome({
        ok: pushed.ok,
        text: `${commitOutcome(rep).text} ${pushOutcome(pushed).text}`
      })
      // Only a push that LANDED moved anything the caller reads (the pushed markers, the ahead count); a rejected one changed nothing, and re-reading for it would be a round trip that reports the same tree.
      if (pushed.ok) onWrote()
    } catch (e) {
      setOutcome({ ok: false, text: gitWriteRequestFailureText(statusOf(e), codeOf(e)) })
    } finally {
      running.current = false
      setBusy(null)
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

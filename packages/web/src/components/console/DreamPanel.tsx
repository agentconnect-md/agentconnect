'use client'

// Dream panel — the console surface for memory dreaming (design:
// docs/designs/memory-dreaming.md §10). Three things in one place:
//
//   1. "Dream now" — a manual trigger. A dream is a MODEL pass over the store
//      plus recent transcripts, so it is slow (minutes) and costs real tokens;
//      the copy says so, and the button reflects the one-in-flight rule rather
//      than letting the user hit a raw 409.
//   2. The job list, polled while anything is pending/running.
//   3. Review — the staged store a completed dream produced, diffed against
//      what is live now, plus Adopt / Discard. A dream is STAGED by design, so
//      the trigger without this review surface would be a dead end.
//
// Everything proxies live to the owning daemon, so an offline agent is an
// expected state (503 → a friendly notice), not an error.

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  startDream,
  listDreams,
  adoptDream,
  discardDream,
  acceptDreamSkill,
  fetchDreamSkill,
  dismissDreamSkill,
  cancelDream,
  listDreamFiles,
  fetchDreamFileFull,
  fetchAgentMemoryFull,
  listAgentMemory,
  isDreamTerminal,
  fmtCountCompact,
  fmtCost,
  ApiError,
  type DreamDto,
  type DreamSkillContentDto,
  type MemoryFileEntry
} from '@/lib/api'
import { Icon, Button } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { LineDiff } from '@/components/console/LineDiff'

/** While a dream is in flight the list changes fast. */
const POLL_MS = 4000
/** …and even when settled it is NOT static: a scheduled dream (or another
 *  console) can start one, so revalidate slowly rather than going silent. */
const IDLE_POLL_MS = 30_000
/** Max the CP list route accepts. */
const DREAM_PAGE = 50

/** Human label for a job's lifecycle state. */
const STATUS_LABEL: Record<DreamDto['status'], string> = {
  pending: 'Queued',
  running: 'Dreaming…',
  completed: 'Ready to review',
  failed: 'Failed',
  canceled: 'Canceled',
  adopted: 'Adopted',
  discarded: 'Discarded',
  superseded: 'Superseded'
}

/** Status dot colour per lifecycle state — the same visual language the
 *  Schedules run history uses (RUN_STYLE there), so a dream list reads like a
 *  run list rather than inventing a second vocabulary. */
const STATUS_DOT: Record<DreamDto['status'], string> = {
  pending: 'var(--status-paused)',
  running: 'var(--status-paused)',
  completed: 'var(--brand)',
  failed: 'var(--status-error)',
  canceled: 'var(--text-disabled)',
  adopted: 'var(--status-online)',
  discarded: 'var(--text-disabled)',
  superseded: 'var(--text-disabled)'
}

function statusTone(status: DreamDto['status']): string {
  if (status === 'completed') return 'text-(--brand-soft-text)'
  if (status === 'failed') return 'text-(--status-error)'
  if (status === 'adopted') return 'text-(--status-online)'
  return 'text-(--text-tertiary)'
}

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}

function elapsed(createdAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null
  const ms = Date.parse(endedAt) - Date.parse(createdAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DreamPanel({
  agentId,
  canEdit,
  autoAcceptMemory,
  sessionBasePath
}: {
  agentId: string
  canEdit: boolean
  autoAcceptMemory: boolean
  sessionBasePath?: string
}) {
  const [dreams, setDreams] = useState<DreamDto[] | null>(null)
  // Fetched separately: a proposal outlives the store lifecycle, so it must not
  // depend on how deep the newest-first history has grown.
  const [pendingSkillDreams, setPendingSkillDreams] = useState<DreamDto[]>([])
  const [listError, setListError] = useState<string | null>(null)
  // 409 DAEMON_FEATURE_MISSING — this agent's daemon predates dreaming. Not an
  // error the user can act on except by upgrading, so it gets its own state.
  const [unsupported, setUnsupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)
  const [confirmAdopt, setConfirmAdopt] = useState<{ dreamId: string; reviewToken?: string } | null>(null)
  // The snapshot fence tripped: the live store moved under this dream. Adopting anyway is a
  // whole-directory swap, so it drops live files not in the staged proposal (#1792).
  const [forceAdopt, setForceAdopt] = useState<{
    dreamId: string
    reviewToken?: string
    droppedFiles: string[]
  } | null>(null)
  const listRequest = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++listRequest.current
    try {
      // Proposed skills deliberately survive adoption/discard until reviewed, so a
      // pending candidate must not fall off the list behind newer runs. Ask for
      // the full window the CP allows rather than one screen's worth.
      const [rows, pending] = await Promise.all([
        listDreams(agentId, DREAM_PAGE),
        listDreams(agentId, DREAM_PAGE, { pendingSkills: true }).catch(() => [] as DreamDto[])
      ])
      // EVERY state write goes behind the fence: a delayed older request must not
      // publish after a newer one and re-offer an already-reviewed candidate.
      if (request !== listRequest.current) return
      setPendingSkillDreams(pending)
      setDreams(rows)
      setListError(null)
      setUnsupported(false)
    } catch (e) {
      if (request !== listRequest.current) return
      setDreams([])
      if (e instanceof ApiError && e.code === 'DAEMON_FEATURE_MISSING') {
        setUnsupported(true)
        setListError(null)
        return
      }
      setListError(
        e instanceof ApiError && e.status === 503
          ? 'This agent’s daemon is offline — dreams are served live from it.'
          : e instanceof Error
            ? e.message
            : 'Could not load dreams.'
      )
    }
  }, [agentId])

  useEffect(() => {
    setDreams(null)
    setReviewing(null)
    void refresh()
  }, [refresh])

  // Poll fast while something is in flight, slowly otherwise — a settled list is
  // NOT static now that dreams can start on a schedule or from another client.
  const inFlight = (dreams ?? []).some((d) => !isDreamTerminal(d.status))
  useEffect(() => {
    if (unsupported) return // nothing changes until that daemon is upgraded
    const timer = setInterval(() => void refresh(), inFlight ? POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [inFlight, refresh, unsupported])

  const run = async (fn: () => Promise<unknown>, action: 'start' | 'other' = 'other') => {
    setBusy(true)
    setActionError(null)
    setActionNotice(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      // 409 means different things even within START: a racing trigger can hit
      // the one-in-flight rule, while a daemon security hold also returns a 409
      // with an actionable reason. Rewrite only the known race; every other
      // conflict keeps the server's specific message.
      setActionError(
        e instanceof ApiError &&
          e.status === 409 &&
          action === 'start' &&
          e.message.includes('a dream is already in flight')
          ? 'A dream is already running for this agent — wait for it to finish, or cancel it.'
          : e instanceof ApiError && e.status === 503
            ? 'This agent’s daemon is offline.'
            : e instanceof Error
              ? e.message
              : 'That did not work.'
      )
      // A conflict usually means our view is stale (someone else started or
      // adopted something) — resync so the row and its actions are correct.
      if (e instanceof ApiError && e.status === 409) await refresh()
    } finally {
      setBusy(false)
    }
  }

  // The live files a forced adopt would drop: present in the live store, absent from
  // the staged proposal. Recomputed fresh at fence time (not reused from review load),
  // because the fence tripped precisely because live moved. Provenance is unknowable
  // without the snapshot, so these are "not in the staged version", not "added since".
  const droppedOnForce = async (dreamId: string): Promise<string[]> => {
    try {
      const [stagedPage, livePage] = await Promise.all([listDreamFiles(agentId, dreamId), listAgentMemory(agentId)])
      const stagedNames = new Set(stagedPage.files.map((f: MemoryFileEntry) => f.name))
      const liveNames = livePage.exists ? livePage.files.map((f: MemoryFileEntry) => f.name) : []
      return liveNames.filter((name: string) => !stagedNames.has(name)).sort((a, b) => a.localeCompare(b))
    } catch {
      // The warning degrades to the generic wording rather than blocking the force path.
      return []
    }
  }

  // Adopt is its own handler, not `run`, because the snapshot-fence 409 is not a
  // dead end: it opens the "adopt anyway" (force) path instead of surfacing a bare
  // error the operator cannot act on (#1792). Every other failure behaves like `run`.
  const adopt = async (dreamId: string, reviewToken: string | undefined, force: boolean) => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      await adoptDream(agentId, dreamId, force, reviewToken)
      setReviewing(null)
      setActionNotice('Memory adopted. Outdated proposals were moved to History.')
      await refresh()
    } catch (e) {
      const fence =
        !force &&
        e instanceof ApiError &&
        e.status === 409 &&
        /changed since this dream was snapshotted/.test(e.message)
      if (fence) {
        // Recompute the live-only set NOW, so the warning names what is actually live
        // at the moment of the destructive swap, not what the review panel saw earlier.
        const droppedFiles = await droppedOnForce(dreamId)
        await refresh()
        setForceAdopt({ dreamId, reviewToken, droppedFiles })
      } else {
        setActionError(
          e instanceof ApiError && e.status === 503
            ? 'This agent’s daemon is offline.'
            : e instanceof Error
              ? e.message
              : 'That did not work.'
        )
        if (e instanceof ApiError && e.status === 409) await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  // The panel only mounts when dreaming is on, so the remaining blockers are
  // permission and the one-in-flight rule.
  const startBlocker = !canEdit
    ? 'You need edit access on this agent to run a dream.'
    : inFlight
      ? 'A dream is already running for this agent.'
      : null

  // The agent's daemon predates dreaming. Show one calm line rather than a
  // trigger that can only 409 — but don't hide it silently either, or an
  // operator who just enabled dreaming has no idea why nothing appeared.
  if (unsupported) {
    return (
      <div className="card overflow-hidden max-desktop:rounded-lg">
        <div className="cardhead">
          <div className="cardtitle">Dreams</div>
        </div>
        <div className="p-4 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          Dreams need a newer version of this agent’s daemon. Upgrade it to consolidate memory here.
        </div>
      </div>
    )
  }

  // Keep current work visible, but move terminal history behind one quiet
  // disclosure so the Memory page stays focused on live memory.
  const activeDreams = (dreams ?? []).filter((dream) =>
    dream.status === 'completed' ? true : !isDreamTerminal(dream.status)
  )
  const pastDreams = (dreams ?? []).filter((dream) => dream.status !== 'completed' && isDreamTerminal(dream.status))
  const hasContentBeforeHistory = Boolean(
    (startBlocker && !inFlight) || actionError || actionNotice || listError || activeDreams.length || reviewing
  )

  const discard = (dreamId: string) =>
    void run(async () => {
      await discardDream(agentId, dreamId)
      setReviewing((current) => (current === dreamId ? null : current))
      setActionNotice('Dream discarded.')
    })

  const renderDreamRows = (rows: DreamDto[]) => (
    <ul className="flex list-none flex-col gap-0 p-0">
      {rows.map((dream) => {
        const duration = elapsed(dream.createdAt, dream.endedAt)
        const usage = dream.usage
        const metrics = [
          usage?.totalTokens !== undefined
            ? `${fmtCountCompact(usage.totalTokens)} tokens`
            : isDreamTerminal(dream.status)
              ? 'Tokens unavailable'
              : null,
          usage?.costAmount !== undefined ? fmtCost(usage.costAmount, usage.costCurrency) : null,
          dream.model,
          duration
        ].filter((value): value is string => Boolean(value))
        const byteMetrics = usage
          ? `${fmtBytes(usage.inputBytes)} prompt · ${fmtBytes(usage.outputBytes)} output`
          : null
        return (
          <li
            key={dream.dreamId}
            className="flex flex-wrap items-center justify-between gap-2 border-t border-(--border-subtle) py-2 first:border-t-0 first:pt-0 last:pb-0"
          >
            <span
              className="mt-[6px] h-2 w-2 flex-none self-start rounded-full"
              style={{ background: STATUS_DOT[dream.status] }}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
              <span className={`font-sans text-[12.5px] font-semibold leading-normal ${statusTone(dream.status)}`}>
                {STATUS_LABEL[dream.status]}
                {dream.trigger === 'schedule' ? ' · scheduled' : ''}
              </span>
              <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                {when(dream.createdAt)}
                {dream.error ? ` · ${dream.error.message}` : ''}
              </span>
              {metrics.length || byteMetrics ? (
                <span className="font-mono text-[10.5px] font-normal leading-normal text-(--text-tertiary)">
                  {[...metrics, ...(byteMetrics ? [byteMetrics] : [])].join(' · ')}
                </span>
              ) : null}
            </span>
            <span className="flex flex-none items-center gap-2">
              {sessionBasePath && dream.executionSessionId ? (
                <Link
                  href={`${sessionBasePath}/${encodeURIComponent(dream.executionSessionId)}`}
                  className="lnk font-sans text-[11.5px] font-semibold leading-normal"
                >
                  Open session
                </Link>
              ) : null}
              {dream.status === 'completed' ? (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={() => setReviewing(reviewing === dream.dreamId ? null : dream.dreamId)}
                >
                  {reviewing === dream.dreamId ? 'Hide' : 'Review'}
                </Button>
              ) : null}
              {dream.status === 'completed' && canEdit ? (
                <Button variant="secondary" size="xs" disabled={busy} onClick={() => discard(dream.dreamId)}>
                  Discard
                </Button>
              ) : null}
              {!isDreamTerminal(dream.status) && canEdit ? (
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  onClick={() => void run(() => cancelDream(agentId, dream.dreamId))}
                >
                  Cancel
                </Button>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg">
      <div className="cardhead min-w-0 justify-between">
        <div className="cardtitle min-w-0 flex-1">Dreams</div>
        <span title={startBlocker ?? undefined}>
          <Button variant="secondary" size="xs" disabled={busy || !!startBlocker} onClick={() => setConfirmStart(true)}>
            {inFlight ? 'Dreaming…' : 'Dream now'}
          </Button>
        </span>
      </div>

      <div className="flex flex-col gap-3 p-4">
        {startBlocker && !inFlight ? (
          <div className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {startBlocker}
          </div>
        ) : null}
        {actionError ? (
          <div className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">{actionError}</div>
        ) : null}
        {actionNotice ? (
          <div className="font-sans text-[12px] font-normal leading-normal text-(--status-online)">{actionNotice}</div>
        ) : null}
        {listError ? (
          <div className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">{listError}</div>
        ) : null}

        {dreams === null ? (
          <div className="flex items-center gap-2 font-sans text-[12px] text-(--text-tertiary)">
            <Spinner /> Loading dreams…
          </div>
        ) : dreams.length === 0 && !listError ? (
          <div className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">No dreams yet.</div>
        ) : null}

        {activeDreams.length ? renderDreamRows(activeDreams) : null}

        {reviewing ? (
          <DreamReview
            agentId={agentId}
            dreamId={reviewing}
            canEdit={canEdit}
            busy={busy}
            onAdopt={(reviewToken) => setConfirmAdopt({ dreamId: reviewing, reviewToken })}
            onDiscard={() => discard(reviewing)}
          />
        ) : null}

        {/* Mined skill recommendations. Deliberately OUTSIDE the store-review
            block: a skill's review lifecycle is independent of the store
            proposal (§7), so they stay actionable whether or not the store was
            adopted, and after the store staging is gone. */}
        {pendingSkillDreams.map((dream) => {
          const proposed = (dream.skills ?? []).filter((skill) => skill.state === 'proposed')
          if (proposed.length === 0) return null
          return (
            <DreamSkills
              key={`skills-${dream.dreamId}`}
              proposed={proposed}
              busy={busy || !canEdit}
              agentId={agentId}
              dreamId={dream.dreamId}
              onAccept={(name, reviewToken) =>
                void run(() => acceptDreamSkill(agentId, dream.dreamId, name, reviewToken))
              }
              onDismiss={(name) => void run(() => dismissDreamSkill(agentId, dream.dreamId, name))}
            />
          )
        })}

        {pastDreams.length ? (
          <details className="group">
            <summary
              className={`flex cursor-pointer list-none items-center justify-between gap-2 font-sans text-[12px] font-semibold leading-normal text-(--text-secondary) transition-colors hover:text-(--text-primary) [&::-webkit-details-marker]:hidden ${
                hasContentBeforeHistory ? 'border-t border-(--border-subtle) pt-3' : ''
              }`}
            >
              <span className="inline-flex items-center gap-1">
                <Icon name="chevron-right" size={13} className="transition-transform group-open:rotate-90" />
                History
              </span>
              <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
                {pastDreams.length}
              </span>
            </summary>
            <div className="mt-3">{renderDreamRows(pastDreams)}</div>
          </details>
        ) : null}

        {confirmStart ? (
          <ConfirmationDialog
            title="Start a memory dream?"
            confirmLabel="Start dream"
            onClose={() => setConfirmStart(false)}
            onConfirm={() => {
              setConfirmStart(false)
              void run(() => startDream(agentId), 'start')
            }}
          >
            {`This runs a model over the agent’s memory and recent sessions. It takes a few minutes and uses model tokens. ${
              autoAcceptMemory
                ? 'The memory result is adopted automatically unless live-memory changes conflict. Suggested skills still require review.'
                : 'Nothing changes until you review and adopt the memory result. Suggested skills still require review.'
            }`}
          </ConfirmationDialog>
        ) : null}

        {confirmAdopt ? (
          <ConfirmationDialog
            title="Adopt this dream?"
            confirmLabel="Adopt"
            onClose={() => setConfirmAdopt(null)}
            onConfirm={() => {
              const { dreamId, reviewToken } = confirmAdopt
              setConfirmAdopt(null)
              void adopt(dreamId, reviewToken, false)
            }}
          >
            This replaces the agent’s live memory with the staged version. The current store is kept as a backup, and
            adopting is refused if memory changed underneath this dream.
          </ConfirmationDialog>
        ) : null}

        {forceAdopt ? (
          <ConfirmationDialog
            title="Adopt anyway?"
            confirmLabel="Adopt anyway"
            onClose={() => setForceAdopt(null)}
            onConfirm={() => {
              const { dreamId, reviewToken } = forceAdopt
              setForceAdopt(null)
              void adopt(dreamId, reviewToken, true)
            }}
          >
            {`Memory changed underneath this dream since it was snapshotted. Adopting replaces the whole store with the staged version` +
              (forceAdopt.droppedFiles.length
                ? ` and drops ${forceAdopt.droppedFiles.length} live file${
                    forceAdopt.droppedFiles.length === 1 ? '' : 's'
                  } not in the staged version: ${forceAdopt.droppedFiles.join(', ')}.`
                : `. Any live file not in the staged version is dropped.`) +
              ` The current store is kept as a backup. To keep the newer changes instead, re-run the dream.`}
          </ConfirmationDialog>
        ) : null}
      </div>
    </div>
  )
}

/** Line diff of one staged file against what is live now, for a completed dream. */
function DreamReview({
  agentId,
  dreamId,
  canEdit,
  busy,
  onAdopt,
  onDiscard
}: {
  agentId: string
  dreamId: string
  canEdit: boolean
  busy: boolean
  onAdopt: (reviewToken?: string) => void
  onDiscard: () => void
}) {
  // The UNION of live and staged paths, not just the staged tree. Adoption swaps
  // the whole directory, and a dream deletes a topic simply by omitting it — so
  // a live-only path is a DELETION the reviewer must see. Listing only staged
  // files would hide exactly the most destructive change.
  const [paths, setPaths] = useState<{ name: string; live: boolean; staged: boolean }[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [staged, setStaged] = useState<string>('')
  const [live, setLive] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Same-bytes review fence token from the staged listing; echoed on Adopt so the
  // daemon binds adoption to exactly the bytes shown here (task #36 Phase B).
  const [reviewToken, setReviewToken] = useState<string | undefined>(undefined)
  const request = useRef(0)

  useEffect(() => {
    let alive = true
    setPaths(null)
    setSelected(null)
    setError(null)
    setReviewToken(undefined)
    void (async () => {
      try {
        const [stagedPage, livePage] = await Promise.all([listDreamFiles(agentId, dreamId), listAgentMemory(agentId)])
        if (!alive) return
        setReviewToken(stagedPage.reviewToken)
        const stagedNames = new Set(stagedPage.files.map((f: MemoryFileEntry) => f.name))
        const liveNames = new Set(livePage.exists ? livePage.files.map((f: MemoryFileEntry) => f.name) : [])
        const merged = [...new Set([...stagedNames, ...liveNames])]
          .map((name) => ({ name, live: liveNames.has(name), staged: stagedNames.has(name) }))
          // Deletions first — they are the change most likely to be missed.
          .sort((a, b) => Number(a.staged) - Number(b.staged) || a.name.localeCompare(b.name))
        setPaths(merged)
        setSelected(merged[0]?.name ?? null)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load the staged store.')
      }
    })()
    return () => {
      alive = false
    }
  }, [agentId, dreamId])

  useEffect(() => {
    if (!selected) return
    const id = ++request.current
    setLoading(true)
    void (async () => {
      try {
        // The staged copy and the live file for the same path, so the reviewer
        // can see exactly what adopting would change — including a removal.
        const [stagedFile, liveFile] = await Promise.all([
          fetchDreamFileFull(agentId, dreamId, selected),
          fetchAgentMemoryFull(agentId, selected)
        ])
        if (id !== request.current) return
        setStaged(stagedFile.exists ? stagedFile.content : '')
        setLive(liveFile.exists ? liveFile.content : '')
      } catch (e) {
        if (id === request.current) setError(e instanceof Error ? e.message : 'Could not load that file.')
      } finally {
        if (id === request.current) setLoading(false)
      }
    })()
  }, [agentId, dreamId, selected])

  const deleting = (paths ?? []).filter((p) => p.live && !p.staged)

  return (
    <div className="flex flex-col gap-3 rounded-(--radius-md) border border-(--border-subtle) bg-(--surface-sunken) p-3">
      {error ? <div className="font-sans text-[12px] leading-normal text-(--status-error)">{error}</div> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-1">
          {(paths ?? []).map((file) => (
            <button
              key={file.name}
              type="button"
              onClick={() => setSelected(file.name)}
              className={
                file.name === selected
                  ? 'cursor-pointer rounded-sm border border-(--brand) bg-(--surface-card) px-2 py-1 font-mono text-[11.5px] leading-normal text-(--text-primary)'
                  : 'cursor-pointer rounded-sm border border-(--border-subtle) bg-(--surface-card) px-2 py-1 font-mono text-[11.5px] leading-normal text-(--text-secondary)'
              }
            >
              {file.name}
              {file.live && !file.staged ? ' · deleted' : ''}
            </button>
          ))}
          {paths?.length === 0 ? (
            <span className="font-sans text-[12px] text-(--text-tertiary)">Nothing staged.</span>
          ) : null}
        </span>
        {canEdit ? (
          <span className="flex flex-none items-center gap-2">
            <Button variant="secondary" disabled={busy} onClick={onDiscard}>
              Discard
            </Button>
            <Button disabled={busy || !paths?.some((p) => p.staged)} onClick={() => onAdopt(reviewToken)}>
              <Icon name="check" size={13} /> Adopt
            </Button>
          </span>
        ) : null}
      </div>

      {deleting.length ? (
        <div className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--status-error)">
          Adopting removes {deleting.length} file{deleting.length === 1 ? '' : 's'} the dream left out:{' '}
          {deleting.map((p) => p.name).join(', ')}.
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 font-sans text-[12px] text-(--text-tertiary)">
          <Spinner /> Loading…
        </div>
      ) : selected ? (
        <LineDiff before={live} after={staged} />
      ) : null}
    </div>
  )
}

/**
 * Skills this dream mined and is RECOMMENDING. Never auto-installed: a skill is
 * executable instruction content that steers every later session, so acceptance
 * is always an explicit human act (design §7), independent of the memory store's
 * auto-accept policy.
 */
function DreamSkills({
  agentId,
  dreamId,
  proposed,
  busy,
  onAccept,
  onDismiss
}: {
  agentId: string
  dreamId: string
  proposed: Array<{ name: string; description: string }>
  busy: boolean
  onAccept: (name: string, reviewToken?: string) => void
  onDismiss: (name: string) => void
}) {
  // Accept stays disabled until the body has been opened. The whole safety
  // argument for mined skills is that a human reviewed them, and a
  // model-authored description is not evidence for itself. The map also carries
  // each reviewed skill's fence token (task #36 Phase B), echoed on Accept so
  // publication is bound to the exact reviewed bytes.
  const [reviewTokens, setReviewTokens] = useState<Map<string, string | undefined>>(new Map())
  return (
    <div className="flex flex-col gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) p-3">
      <span className="font-sans text-[12px] font-semibold leading-normal text-(--text-secondary)">
        Suggested skills
      </span>
      <span className="font-sans text-[11px] font-normal leading-[1.5] text-(--text-tertiary)">
        Generated skills always require review before installation. Accepting one installs it for this agent so later
        sessions can reuse it.
      </span>
      {proposed.map((skill) => (
        <div
          key={skill.name}
          className="flex flex-wrap items-start justify-between gap-2 border-t border-(--border-subtle) pt-2 first-of-type:border-t-0 first-of-type:pt-0"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span className="font-mono text-[12px] font-medium leading-normal text-(--text-primary)">{skill.name}</span>
            <span className="font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-secondary)">
              {skill.description}
            </span>
          </span>
          <span className="flex flex-none items-center gap-2">
            <Button variant="secondary" disabled={busy} onClick={() => onDismiss(skill.name)}>
              Dismiss
            </Button>
            <Button
              disabled={busy || !reviewTokens.has(skill.name)}
              onClick={() => onAccept(skill.name, reviewTokens.get(skill.name))}
            >
              Accept
            </Button>
          </span>
          <SkillBody
            agentId={agentId}
            dreamId={dreamId}
            name={skill.name}
            onRead={(reviewToken) => setReviewTokens((current) => new Map(current).set(skill.name, reviewToken))}
          />
        </div>
      ))}
    </div>
  )
}

/** The staged SKILL.md and scripts, behind a disclosure. Opening it is what
 *  enables Accept — see the note in DreamSkills. */
function SkillBody({
  agentId,
  dreamId,
  name,
  onRead
}: {
  agentId: string
  dreamId: string
  name: string
  onRead: (reviewToken?: string) => void
}) {
  const [content, setContent] = useState<DreamSkillContentDto | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <details
      className="w-full"
      onToggle={(e) => {
        if (!(e.currentTarget as HTMLDetailsElement).open || content) return
        void fetchDreamSkill(agentId, dreamId, name)
          .then((body) => {
            setContent(body)
            // Only a body that actually rendered counts as reviewed — a pending
            // request, an error, or vanished staging must all keep Accept off.
            if (body.exists && body.skill) onRead(body.reviewToken)
          })
          .catch((err) => setError(err instanceof Error ? err.message : 'Could not load this skill.'))
      }}
    >
      <summary className="cursor-pointer list-none font-sans text-[11px] font-medium leading-normal text-(--brand-soft-text) [&::-webkit-details-marker]:hidden">
        Show what this installs
      </summary>
      {error ? <div className="mt-1 font-sans text-[11px] text-(--status-error)">{error}</div> : null}
      {content?.exists === false ? (
        <div className="mt-1 font-sans text-[11px] text-(--text-tertiary)">This candidate is no longer staged.</div>
      ) : null}
      {content?.skill ? (
        <pre className="mt-1 max-h-[240px] overflow-auto rounded-sm border border-(--border-subtle) bg-(--surface-card) p-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-(--text-primary)">
          {content.skill}
        </pre>
      ) : null}
      {(content?.scripts ?? []).map((script) => (
        <div key={script.path} className="mt-1 flex flex-col gap-[2px]">
          <span className="font-mono text-[10.5px] font-medium leading-normal text-(--text-tertiary)">
            scripts/{script.path}
          </span>
          <pre className="max-h-[240px] overflow-auto rounded-sm border border-(--border-subtle) bg-(--surface-card) p-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap text-(--text-primary)">
            {script.content}
          </pre>
        </div>
      ))}
    </details>
  )
}

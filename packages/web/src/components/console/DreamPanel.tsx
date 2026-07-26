'use client'

// Dream panel — the console surface for memory dreaming (design:
// docs/designs/memory-dreaming.md §10). Three things in one place:
//
//   1. "Dream now" — a manual trigger. A dream is a MODEL pass over the store
//      plus recent transcripts, so it is slow (minutes) and costs real tokens;
//      the copy says so, and the button reflects the one-in-flight rule rather
//      than letting the user hit a raw 409.
//   2. The job list, polled while anything is pending/running.
//   3. Review — the staged store a completed dream produced, side by side with
//      what is live now, plus Adopt / Discard. A dream is STAGED by design, so
//      the trigger without this review surface would be a dead end.
//
// Everything proxies live to the owning daemon, so an offline agent is an
// expected state (503 → a friendly notice), not an error.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startDream,
  listDreams,
  adoptDream,
  discardDream,
  cancelDream,
  listDreamFiles,
  fetchDreamFileFull,
  fetchAgentMemoryFull,
  listAgentMemory,
  isDreamTerminal,
  ApiError,
  type DreamDto,
  type MemoryFileEntry
} from '@/lib/api'
import { Icon, Button } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'

/** While a dream is in flight the list changes fast. */
const POLL_MS = 4000
/** …and even when settled it is NOT static: a scheduled dream (or another
 *  console) can start one, so revalidate slowly rather than going silent. */
const IDLE_POLL_MS = 30_000

/** Human label for a job's lifecycle state. */
const STATUS_LABEL: Record<DreamDto['status'], string> = {
  pending: 'Queued',
  running: 'Dreaming…',
  completed: 'Ready to review',
  failed: 'Failed',
  canceled: 'Canceled',
  adopted: 'Adopted',
  discarded: 'Discarded'
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
  discarded: 'var(--text-disabled)'
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

export function DreamPanel({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const [dreams, setDreams] = useState<DreamDto[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  // 409 DAEMON_FEATURE_MISSING — this agent's daemon predates dreaming. Not an
  // error the user can act on except by upgrading, so it gets its own state.
  const [unsupported, setUnsupported] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)
  const [confirmAdopt, setConfirmAdopt] = useState<string | null>(null)
  const listRequest = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++listRequest.current
    try {
      const rows = await listDreams(agentId, 20)
      if (request !== listRequest.current) return
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
    try {
      await fn()
      await refresh()
    } catch (e) {
      // 409 means different things per action: a racing START hit the
      // one-in-flight rule, while a refused ADOPT means the snapshot fence saw
      // live memory change. Only the start case gets our wording — everything
      // else keeps the server's specific message, which says what to do.
      setActionError(
        e instanceof ApiError && e.status === 409 && action === 'start'
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

  const renderDreamRows = (rows: DreamDto[]) => (
    <ul className="flex list-none flex-col gap-0 p-0">
      {rows.map((dream) => (
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
              {when(dream.createdAt)} · {dream.sessionIds.length} session
              {dream.sessionIds.length === 1 ? '' : 's'} mined
              {dream.error ? ` · ${dream.error.message}` : ''}
            </span>
          </span>
          <span className="flex flex-none items-center gap-2">
            {dream.status === 'completed' ? (
              <Button
                variant="secondary"
                size="xs"
                onClick={() => setReviewing(reviewing === dream.dreamId ? null : dream.dreamId)}
              >
                {reviewing === dream.dreamId ? 'Hide' : 'Review'}
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
      ))}
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
            onAdopt={() => setConfirmAdopt(reviewing)}
            onDiscard={() =>
              void run(async () => {
                await discardDream(agentId, reviewing)
                setReviewing(null)
              })
            }
          />
        ) : null}

        {pastDreams.length ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 border-t border-(--border-subtle) pt-3 font-sans text-[12px] font-semibold leading-normal text-(--text-secondary) transition-colors hover:text-(--text-primary) [&::-webkit-details-marker]:hidden">
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
            This runs a model over the agent’s memory and recent sessions. It takes a few minutes and uses model tokens.
            Nothing changes until you review and adopt the result.
          </ConfirmationDialog>
        ) : null}

        {confirmAdopt ? (
          <ConfirmationDialog
            title="Adopt this dream?"
            confirmLabel="Adopt"
            onClose={() => setConfirmAdopt(null)}
            onConfirm={() => {
              const dreamId = confirmAdopt
              setConfirmAdopt(null)
              void run(async () => {
                await adoptDream(agentId, dreamId)
                setReviewing(null)
              })
            }}
          >
            This replaces the agent’s live memory with the staged version. The current store is kept as a backup, and
            adopting is refused if memory changed underneath this dream.
          </ConfirmationDialog>
        ) : null}
      </div>
    </div>
  )
}

/** Side-by-side of one staged file and what is live now, for a completed dream. */
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
  onAdopt: () => void
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
  const request = useRef(0)

  useEffect(() => {
    let alive = true
    setPaths(null)
    setSelected(null)
    setError(null)
    void (async () => {
      try {
        const [stagedPage, livePage] = await Promise.all([listDreamFiles(agentId, dreamId), listAgentMemory(agentId)])
        if (!alive) return
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

  const current = paths?.find((p) => p.name === selected)
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
            <Button disabled={busy || !paths?.some((p) => p.staged)} onClick={onAdopt}>
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
        <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="font-sans text-[11px] font-semibold leading-normal text-(--text-tertiary)">Live now</span>
            <pre className="m-0 max-h-[320px] overflow-auto rounded-sm border border-(--border-subtle) bg-(--surface-card) p-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-(--text-secondary)">
              {live || '(this file does not exist yet)'}
            </pre>
          </div>
          <div className="flex flex-col gap-1">
            <span
              className={
                current && current.live && !current.staged
                  ? 'font-sans text-[11px] font-semibold leading-normal text-(--status-error)'
                  : 'font-sans text-[11px] font-semibold leading-normal text-(--brand-soft-text)'
              }
            >
              {current && current.live && !current.staged ? 'Deleted by this dream' : 'Staged by this dream'}
            </span>
            <pre className="m-0 max-h-[320px] overflow-auto rounded-sm border border-(--border-subtle) bg-(--surface-card) p-2 font-mono text-[11.5px] leading-[1.5] whitespace-pre-wrap text-(--text-primary)">
              {current && current.live && !current.staged ? '(removed — this file will be deleted)' : staged}
            </pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}

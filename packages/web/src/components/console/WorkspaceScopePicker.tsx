'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'
import type { Session } from '@/lib/data'
import type { SessionIsolationLabel } from '@/lib/session-isolation'

type WorktreeIdentity = {
  context?: string
  title: string
  fullTitle: string
}

/** Split GitHub session titles such as `PR #576: fix(auth): …` into
 *  the stable review coordinate and the human-authored title. Other session
 *  titles stay intact instead of being guessed into GitHub-shaped fields. */
export function worktreeIdentity(
  session: Pick<Session, 'id' | 'title'> | undefined,
  fallbackId: string
): WorktreeIdentity {
  const fullTitle = session?.title.trim() || `Session ${fallbackId.slice(0, 8)}`
  const match = /^(PR|Issue)\s+((?:[\w.-]+\/[\w.-]+)?#\d+):?\s*(.*)$/i.exec(fullTitle)
  if (!match) return { title: fullTitle, fullTitle }
  return {
    context: `${match[1]!.toLowerCase() === 'pr' ? 'PR' : 'Issue'} ${match[2]!}`,
    title: match[3]!.trim(),
    fullTitle
  }
}

function worktreeTooltip(identity: WorktreeIdentity, time: string | undefined): string {
  return time && time !== '—' ? `${identity.fullTitle} · ${time}` : identity.fullTitle
}

export function WorkspaceScopePicker({
  primaryBranch,
  isolationLabel,
  sessions,
  selectedSessionId,
  selectedSession,
  loading,
  hasMore,
  loadingMore,
  onChange,
  onLoadMore,
  orgPath
}: {
  primaryBranch: string
  /** What this agent's session isolation is CALLED, from its effective boundary (git-workspace-model.md §11) — a worktree only where nothing encloses the runtime. */
  isolationLabel: SessionIsolationLabel
  sessions: Session[]
  selectedSessionId: string | null
  selectedSession?: Session
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  onChange: (sessionId: string | null) => void
  onLoadMore: () => void
  orgPath: (path: string) => string
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const worktrees = sessions.filter(
    (session) => session.workspaceIsolation === 'session' && session.contentPurgedAt === undefined
  )
  const selectedWorktree = selectedSessionId
    ? (worktrees.find((session) => session.id === selectedSessionId) ?? selectedSession)
    : undefined
  const menuWorktrees =
    selectedWorktree && !worktrees.some((session) => session.id === selectedWorktree.id)
      ? [selectedWorktree, ...worktrees]
      : worktrees
  const selectedIdentity = selectedSessionId ? worktreeIdentity(selectedWorktree, selectedSessionId) : undefined
  const primaryBranchLabel = primaryBranch.trim() || 'HEAD'
  const canChooseCheckout = selectedSessionId !== null || menuWorktrees.length > 0 || hasMore

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('[data-workspace-choice][aria-checked="true"]')?.focus()
    })
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
    }
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [open])

  const openFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    setOpen(true)
  }

  const moveChoiceFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      if (event.key === 'Tab') setOpen(false)
      return
    }
    event.preventDefault()
    const choices = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-workspace-choice]'))
    if (choices.length === 0) return
    const focused = choices.indexOf(document.activeElement as HTMLButtonElement)
    const selected = choices.findIndex((choice) => choice.getAttribute('aria-checked') === 'true')
    const current = focused >= 0 ? focused : Math.max(0, selected)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length
    choices[next]?.focus()
  }

  const pick = (sessionId: string | null) => {
    setOpen(false)
    onChange(sessionId)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const sessionHref = (sessionId: string) => orgPath(`/sessions/${encodeURIComponent(sessionId)}`)

  return (
    <div className={`relative w-full min-w-0 ${open ? 'z-30' : ''}`}>
      <div className="relative min-w-0">
        <div
          className={`flex h-7 min-w-0 items-center overflow-hidden rounded-md border bg-(--surface-card) ${
            !canChooseCheckout
              ? 'border-(--border-subtle)'
              : open
                ? 'border-(--border-focus) ring-[3px] ring-(--brand-ring)'
                : 'border-(--border-subtle) hover:border-(--border-strong) hover:bg-(--surface-hover) focus-within:border-(--border-focus) focus-within:ring-[3px] focus-within:ring-(--brand-ring)'
          }`}
        >
          {canChooseCheckout ? (
            <button
              ref={triggerRef}
              type="button"
              className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2 text-left text-(--text-primary) outline-none"
              aria-label={`Workspace checkout: ${selectedIdentity?.fullTitle ?? primaryBranchLabel}`}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              onClick={() => setOpen((current) => !current)}
              onKeyDown={openFromKeyboard}
            >
              <Icon name="git-branch" size={13} className="flex-none text-(--text-tertiary)" />
              {selectedIdentity ? (
                <span
                  className="flex min-w-0 flex-1 items-baseline gap-1.5"
                  title={worktreeTooltip(selectedIdentity, selectedWorktree?.time)}
                >
                  {selectedIdentity.context ? (
                    <span className="flex-none font-sans text-[12px] font-semibold leading-normal">
                      {selectedIdentity.context}
                    </span>
                  ) : null}
                  {selectedIdentity.title ? (
                    <span
                      className={`truncate font-sans text-[12px] leading-normal ${
                        selectedIdentity.context
                          ? 'font-normal text-(--text-secondary)'
                          : 'font-medium text-(--text-primary)'
                      }`}
                    >
                      {selectedIdentity.title}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="truncate font-sans text-[12px] font-semibold leading-normal">
                  {primaryBranchLabel}
                </span>
              )}
            </button>
          ) : (
            <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-(--text-primary)">
              <Icon name="git-branch" size={13} className="flex-none text-(--text-tertiary)" />
              <span className="truncate font-sans text-[12px] font-semibold leading-normal">{primaryBranchLabel}</span>
            </div>
          )}

          {selectedSessionId ? (
            <Link
              href={sessionHref(selectedSessionId)}
              className="mx-1 inline-flex h-5 flex-none items-center gap-1 rounded-sm border border-(--border-default) bg-(--surface-card) px-1.5 font-sans text-[11px] font-medium leading-normal text-(--text-secondary) no-underline hover:border-(--border-strong) hover:bg-(--surface-hover) hover:text-(--text-primary)"
              title="Open this session"
              onClick={() => setOpen(false)}
            >
              <Icon name="messages-square" size={11} />
              <span className="max-desktop:hidden">Session</span>
            </Link>
          ) : null}

          {canChooseCheckout ? (
            <button
              type="button"
              className="flex h-full w-8 flex-none cursor-pointer items-center justify-center border-0 border-l border-(--border-subtle) bg-transparent text-(--text-tertiary) outline-none hover:bg-(--surface-hover) hover:text-(--text-primary)"
              aria-label={open ? 'Close workspace checkout menu' : 'Open workspace checkout menu'}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-controls={open ? menuId : undefined}
              title={open ? 'Close checkout menu' : 'Choose checkout'}
              onClick={() => setOpen((current) => !current)}
              onKeyDown={openFromKeyboard}
            >
              <Icon name="chevron-down" size={14} className={open ? 'rotate-180' : ''} />
            </button>
          ) : null}
        </div>

        {canChooseCheckout && open ? (
          <>
            <span className="fixed inset-0 z-20" aria-hidden onClick={() => setOpen(false)} />
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label="Workspace checkout"
              className="fmenu right-0 left-auto z-30 w-[min(max(120%,360px),calc(100vw-32px))] max-h-none min-w-0 overflow-hidden rounded-lg p-0 shadow-(--shadow-lg)"
              onKeyDown={moveChoiceFocus}
            >
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selectedSessionId === null}
                data-workspace-choice
                className={`fopt h-7 min-h-7 rounded-none px-4 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--brand) ${
                  selectedSessionId === null ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)' : ''
                }`}
                onClick={() => pick(null)}
              >
                <Icon name={selectedSessionId === null ? 'check' : 'git-branch'} size={14} className="flex-none" />
                <span className="min-w-0 flex-1 truncate font-semibold" title={primaryBranchLabel}>
                  {primaryBranchLabel}
                </span>
              </button>

              <div className="border-t border-(--border-subtle)">
                <div className="eyebrow flex h-9 items-center gap-2 px-4 text-[10.5px]">
                  <span>{isolationLabel.checkouts}</span>
                  <span aria-hidden>·</span>
                  <span>{menuWorktrees.length}</span>
                </div>
                <div className="max-h-[320px] overflow-y-auto">
                  {menuWorktrees.map((session) => {
                    const identity = worktreeIdentity(session, session.id)
                    const selected = session.id === selectedSessionId
                    return (
                      <div
                        key={session.id}
                        className={`flex h-7 items-center ${
                          selected
                            ? 'bg-(--brand-soft) text-(--brand-soft-text) hover:bg-(--brand-soft)'
                            : 'hover:bg-(--surface-hover)'
                        }`}
                      >
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          data-workspace-choice
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch border-0 bg-transparent px-4 text-left text-inherit outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-(--brand)"
                          title={worktreeTooltip(identity, session.time)}
                          onClick={() => pick(session.id)}
                        >
                          <Icon name={selected ? 'check' : 'git-branch'} size={14} className="flex-none" />
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            {identity.context ? (
                              <span className="flex-none font-sans text-[12px] font-semibold leading-normal">
                                {identity.context}
                              </span>
                            ) : null}
                            {identity.title ? (
                              <span
                                className={`truncate font-sans text-[12px] leading-normal ${
                                  selected
                                    ? 'font-normal text-(--brand-soft-text)'
                                    : identity.context
                                      ? 'font-normal text-(--text-secondary)'
                                      : 'font-medium text-(--text-primary)'
                                }`}
                              >
                                {identity.title}
                              </span>
                            ) : null}
                          </span>
                        </button>
                        <Link
                          href={sessionHref(session.id)}
                          className="mr-3 inline-flex h-5 flex-none items-center gap-1 rounded-sm border border-(--border-default) bg-(--surface-card) px-1.5 font-sans text-[11px] font-medium leading-normal text-(--text-secondary) no-underline hover:border-(--border-strong) hover:bg-(--surface-hover) hover:text-(--text-primary)"
                          title="Open this session"
                          onClick={() => setOpen(false)}
                        >
                          <Icon name="messages-square" size={11} />
                          <span className="max-desktop:hidden">Session</span>
                        </Link>
                      </div>
                    )
                  })}
                  {loading && menuWorktrees.length === 0 ? (
                    <div className="px-4 py-5 text-center font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      Loading {isolationLabel.checkouts}…
                    </div>
                  ) : !hasMore && menuWorktrees.length === 0 ? (
                    <div className="px-4 py-5 text-center font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                      No {isolationLabel.checkouts} yet.
                    </div>
                  ) : null}
                </div>
              </div>

              {(menuWorktrees.length > 0 || hasMore) && (
                <div className="flex min-h-10 items-center gap-3 border-t border-(--border-subtle) bg-(--surface-app) px-4 py-2">
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    Showing {menuWorktrees.length} recent{' '}
                    {menuWorktrees.length === 1 ? isolationLabel.checkout : isolationLabel.checkouts}
                  </span>
                  {hasMore ? (
                    <button
                      type="button"
                      onClick={onLoadMore}
                      disabled={loadingMore}
                      className="lnk ml-auto flex-none text-[12px] disabled:cursor-default disabled:opacity-50"
                    >
                      {loadingMore ? 'Loading…' : 'Load older'}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

'use client'

// Getting-started tutorial: 1a is the floating pill in the console's bottom-right
// corner; 1b is the 400px slide-over drawer it opens, one step per slide. A slide
// advances when its live signal completes OR when Next skips it; the org's current
// step persists server-side (`org.gettingStartedStep`, best-effort — the PATCH is
// owner-only). Once every step is passed the slide closes itself and the pill goes.
//
// Not built yet (no shipped backing — added when their signals land, preset-agents.md
// §3/§6): the "runtime signed in" needs-attention item (probe status, §6.2) and the
// per-item "Ask Assistant" automation (the assistant preset + delegated MCP writes,
// §6.3/§6.4).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { isAuthConfigured } from '@/lib/auth'
import { computeGettingStarted, ringDash, type GsAction } from '@/lib/getting-started'
import { featureFlagEnabled } from '@/lib/feature-flags'
import {
  SlackSlideBody,
  useGithubAppEnabled,
  useGithubProfileLinked,
  useGsActions,
  useSessionAccessCardAvailable,
  useSlackPlatformAppAvailable
} from './GettingStartedChecklist'
import { Button, Icon } from '@/components/ui'

// A r=10.5 progress ring (viewBox 0 0 26 26), rotated so it fills clockwise from 12
// o'clock — the exact svg the design uses in the pill, drawer header and rail.
function Ring({ ring, size, track }: { ring: string; size: number; track: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" className="flex-none -rotate-90">
      <circle cx="13" cy="13" r="10.5" fill="none" stroke="var(--gray-150)" strokeWidth={track} />
      <circle
        cx="13"
        cy="13"
        r="10.5"
        fill="none"
        stroke="var(--brand)"
        strokeWidth={track}
        strokeLinecap="round"
        strokeDasharray={ring}
      />
    </svg>
  )
}

// "Skip for now" is a per-DEVICE console preference (like the rail collapse / theme),
// not CP state — nothing server-side changes by hiding a derived checklist.
const GS_SKIP_KEY = 'ac.gs-skipped'
// The session-access step is a look-don't-touch review with no CP signal — the CTA
// click is the completion, recorded on this device only. Keyed PER ORG: reviewing one
// org's policy must not tick the step (or self-dismiss the tutorial) in another org.
const saReviewedKey = (orgId: string) => `ac.gs-session-access-reviewed:${orgId}`
const GS_OPEN_EVENT = 'ac:gs-open'

/** Re-open the checklist from anywhere in the chrome (rail account menu), un-skipping it. */
export function openGettingStarted() {
  try {
    localStorage.removeItem(GS_SKIP_KEY)
  } catch {
    /* storage unavailable — the drawer still opens for this session */
  }
  window.dispatchEvent(new Event(GS_OPEN_EVENT))
}

export default function GettingStarted() {
  const { agents, daemons, integrations, allSessions, orgHasSessions, members, loading } = useConsoleData()
  const { activeOrg, updateOrg } = useOrgs()
  const { runAction } = useGsActions()
  const pathname = usePathname()
  const authOn = isAuthConfigured()

  const [drawerOpen, setDrawerOpen] = useState(false)
  // Manually toggled NON-current rows; the current step is always open regardless.
  const [expanded, setExpanded] = useState<string | null>(null)
  // Starts skipped so a skipper never flashes the pill before the stored flag is read
  // (localStorage is client-only, so it can't be read during SSR/first render).
  const [skipped, setSkipped] = useState(true)
  // Per-org client state, KEYED by org id at render time: an effect-only reset would
  // leave one commit where a cached org switch still renders — and auto-advances /
  // persists — with the previous org's values. `saReviewed` mirrors this org's
  // localStorage flag; `localFloor` covers the window before the PATCHed org list
  // refreshes, and non-owners whose PATCH the CP refuses (session-local progress).
  const orgId = activeOrg?.id ?? null
  const [saReviewed, setSaReviewed] = useState<{ orgId: string | null; on: boolean }>({ orgId: null, on: false })
  const [localFloor, setLocalFloor] = useState<{ orgId: string | null; step: number }>({ orgId: null, step: 0 })
  const sessionAccessReviewed = saReviewed.orgId === orgId && saReviewed.on
  const localStep = localFloor.orgId === orgId ? localFloor.step : 0

  useEffect(() => {
    try {
      setSkipped(localStorage.getItem(GS_SKIP_KEY) === '1')
    } catch {
      setSkipped(false)
    }
    const onOpen = () => {
      setSkipped(false)
      setDrawerOpen(true)
    }
    window.addEventListener(GS_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(GS_OPEN_EVENT, onOpen)
  }, [])

  const githubLinked = useGithubProfileLinked()
  const githubEnabled = useGithubAppEnabled()
  const sessionAccessAvailable = useSessionAccessCardAvailable()
  // Local mode (no platform-published Slack app): the slack row falls back to the
  // default GsRow, whose CTA opens the Slack integration wizard.
  const slackOneClick = useSlackPlatformAppAvailable()
  const gs = useMemo(
    () =>
      computeGettingStarted({
        agents,
        daemons,
        integrations,
        sessions: allSessions,
        members,
        authOn,
        orgHasSessions,
        githubLinked,
        githubEnabled,
        sessionAccessAvailable,
        sessionAccessReviewed,
        // Cloud pool on ⇒ the "Connect a daemon" step is dropped (lib/getting-started.ts).
        poolEnabled: featureFlagEnabled('daemon-pool')
      }),
    [
      agents,
      daemons,
      integrations,
      allSessions,
      members,
      authOn,
      orgHasSessions,
      githubLinked,
      githubEnabled,
      sessionAccessAvailable,
      sessionAccessReviewed
    ]
  )

  // ── tutorial position ──────────────────────────────────────────────────────
  const storedStep = activeOrg?.gettingStartedStep ?? 0
  // Load THIS org's reviewed flag (per-org key — see saReviewedKey). Until it lands,
  // the keyed derivation above already reads false for the new org, never A's value.
  useEffect(() => {
    try {
      setSaReviewed({ orgId, on: !!orgId && localStorage.getItem(saReviewedKey(orgId)) === '1' })
    } catch {
      setSaReviewed({ orgId, on: false })
    }
  }, [orgId])
  const step = Math.max(storedStep, localStep)
  const total = gs.items.length
  const finished = total > 0 && step >= total

  const advance = useCallback(
    (next: number) => {
      setLocalFloor({ orgId, step: next })
      if (orgId && next > storedStep) {
        // Best-effort: the PATCH is owner-only server-side and clamped monotonic at
        // the DB (GREATEST), so a refused or stale write never regresses the row.
        void updateOrg(orgId, { gettingStartedStep: next }).catch(() => {})
      }
    },
    [orgId, storedStep, updateOrg]
  )

  // Completing the current step's live signal advances the slide on its own —
  // and chains straight through steps that were already done.
  useEffect(() => {
    if (loading || total === 0 || step >= total) return
    if (gs.items[step]?.done) advance(step + 1)
  }, [loading, total, step, gs, advance])

  // Every step passed ⇒ the slide closes itself (the pill goes with it below).
  useEffect(() => {
    if (finished) setDrawerOpen(false)
  }, [finished])

  // Show on every console page while the checklist is incomplete — including a
  // brand-new org, where the first open step is "Connect a daemon" (or, on the cloud
  // pool, setting up the built-in agent). The full-screen
  // /onboarding wizard is a separate route (AgentsView redirects an empty org there);
  // the pill only steps aside for that route, not for the empty-org state itself.
  const onOnboardingRoute = pathname?.includes('/onboarding')
  // Gate on the aggregate `loading`, not just agents+daemons: the checklist reads
  // integrations, sessions and members too, so a partial first paint showed the pill
  // with a too-low count that then jumped (and could even flash for an org that is
  // already allDone). One transition, once everything has landed.
  if (loading || onOnboardingRoute) return null
  // The pill is the passive nudge — it hides once the tutorial is over (all steps
  // passed or every signal done) or the user skipped the whole thing.
  const showPill = !gs.allDone && !skipped && !finished
  if (!showPill && !drawerOpen) return null

  const stepFraction = total ? Math.min(step, total) / total : 0
  const stepRing = ringDash(stepFraction)
  const shortLabel = `${Math.min(step, total)}/${total}`
  const currentIndex = Math.min(step, Math.max(total - 1, 0))

  const skip = () => {
    try {
      localStorage.setItem(GS_SKIP_KEY, '1')
    } catch {
      /* storage unavailable — the skip holds for this page view */
    }
    setDrawerOpen(false)
    setSkipped(true)
  }

  // Modals (add daemon, set up agent, connect Slack) stack above the drawer (their scrim
  // is z-900, the drawer z-80), so the checklist stays open behind them — the user returns
  // to it when the modal closes. Only close the drawer for actions that navigate the page
  // away (GitHub workspace, Home chat, invite teammates, session access → router.push) —
  // the drawer is fixed in the app shell and would otherwise cover the destination.
  const runFromDrawer = (action: GsAction) => {
    // Clicking through to the policy IS the review — tick the step for THIS org.
    if (action.kind === 'session-access') {
      try {
        if (orgId) localStorage.setItem(saReviewedKey(orgId), '1')
      } catch {
        /* storage unavailable — the tick holds for this page view */
      }
      setSaReviewed({ orgId, on: true })
    }
    const navigates =
      action.kind === 'github' ||
      action.kind === 'github-profile' ||
      action.kind === 'chat' ||
      action.kind === 'members' ||
      action.kind === 'session-access'
    if (navigates) setDrawerOpen(false)
    runAction(action)
  }

  return (
    <>
      {/* 1a — floating pill. On mobile it floats above the bottom-tab chrome (the
          drawer below is already full-width there). */}
      {showPill && !drawerOpen && (
        <div className="fixed right-[26px] bottom-[22px] z-[60] inline-flex h-10 items-center rounded-full border border-(--border-default) bg-(--surface-card) pr-[5px] pl-[9px] shadow-(--shadow-lg) hover:border-(--border-strong) hover:shadow-(--shadow-xl) max-desktop:right-4 max-desktop:bottom-[96px]">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            title="Getting started — open checklist"
            className="inline-flex cursor-pointer items-center gap-[9px] border-0 bg-transparent pr-[9px]"
          >
            <Ring ring={stepRing} size={22} track={3.4} />
            <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
              Getting started
            </span>
            <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">{shortLabel}</span>
          </button>
          {/* Same "Skip for now" the drawer offers — dismissible without opening it first. */}
          <button
            type="button"
            onClick={skip}
            title="Hide the checklist — reopen it from the account menu"
            aria-label="Hide the getting-started checklist"
            className="flex h-[26px] w-[26px] flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      {/* 1b — slide-over drawer */}
      {drawerOpen && (
        <>
          <div
            onClick={() => setDrawerOpen(false)}
            className="fixed inset-0 z-[70] bg-[rgba(17,22,29,.26)] backdrop-blur-[2px]"
          />
          <aside className="fixed top-0 right-0 bottom-0 z-[80] flex w-full max-w-[400px] flex-col border-l border-(--border-default) bg-(--surface-card) shadow-(--shadow-xl)">
            <div className="flex-none border-b border-(--border-subtle) py-[15px] pr-3 pl-[18px]">
              <div className="flex items-center gap-[10px]">
                <Ring ring={stepRing} size={26} track={3} />
                <span className="min-w-0 flex-1 font-sans text-[15px] font-semibold leading-normal text-(--text-primary)">
                  Getting started
                </span>
                <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">
                  Step {Math.min(step + 1, total)} of {total}
                </span>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  title="Close — the checklist stays in the corner"
                  className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover)"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="mt-3 h-[5px] overflow-hidden rounded-[3px] bg-(--gray-150)">
                <div
                  className="h-full rounded-[3px] bg-(--brand)"
                  style={{ width: `${Math.round(stepFraction * 100)}%` }}
                />
              </div>
            </div>

            {/* All steps, one row each — the CURRENT step stays expanded (no toggle);
                the others start collapsed and expand on click for a peek ahead/back. */}
            <div className="flex-1 overflow-auto">
              {gs.items.map((it, i) => {
                const isCurrent = i === currentIndex
                const open = isCurrent || expanded === it.key
                return (
                  <div
                    key={it.key}
                    onClick={isCurrent ? undefined : () => setExpanded((cur) => (cur === it.key ? null : it.key))}
                    className={`flex gap-3 border-b border-(--border-subtle) py-3 pr-[14px] pl-4 last:border-b-0 ${
                      isCurrent ? 'bg-(--brand-soft)' : 'cursor-pointer hover:bg-(--surface-hover)'
                    }`}
                  >
                    <span
                      className={`mt-[1px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full ${
                        it.done
                          ? 'bg-(--brand) text-white'
                          : isCurrent
                            ? 'border-[1.5px] border-(--brand)'
                            : 'border-[1.5px] border-(--border-strong)'
                      }`}
                    >
                      {it.done && <Icon name="check" size={12} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span
                        className={`font-sans text-[13.5px] leading-normal ${
                          it.done
                            ? 'font-normal text-(--text-tertiary) line-through'
                            : 'font-medium text-(--text-primary)'
                        }`}
                      >
                        {it.label}
                      </span>
                      {open &&
                        (it.key === 'slack' && slackOneClick ? (
                          <div className="mt-[5px]" onClick={(e) => e.stopPropagation()}>
                            <SlackSlideBody done={it.done} onManual={() => runFromDrawer(it.action)} />
                          </div>
                        ) : (
                          <>
                            <div className="mt-[5px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                              {it.expl}
                            </div>
                            {!it.done && (
                              <div className="mt-[11px]" onClick={(e) => e.stopPropagation()}>
                                <Button size="sm" onClick={() => runFromDrawer(it.action)}>
                                  {it.ctaLabel}
                                </Button>
                              </div>
                            )}
                          </>
                        ))}
                    </div>
                    {!isCurrent && (
                      <span
                        className="mt-[2px] flex flex-none self-start text-(--text-tertiary) transition-transform"
                        style={{ transform: open ? 'rotate(180deg)' : 'none' }}
                      >
                        <Icon name="chevron-down" size={15} />
                      </span>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="flex flex-none items-center border-t border-(--border-subtle) bg-(--surface-app) px-4 py-3">
              {/* Dismisses the WHOLE Get Started (reopen from the account menu) — unlike
                  the header's ×, which only closes the drawer and keeps the pill. */}
              <Button variant="ghost" size="sm" onClick={skip}>
                Skip for now
              </Button>
              <div className="flex-1" />
              <Button size="sm" onClick={() => advance(step + 1)}>
                Next
                <Icon name="arrow-right" size={14} />
              </Button>
            </div>
          </aside>
        </>
      )}
    </>
  )
}

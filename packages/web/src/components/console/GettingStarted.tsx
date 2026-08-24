'use client'

// Getting-started placement 1a + 1b (design: "Getting Started Placement.dc.html").
// 1a is the floating pill in the console's bottom-right corner; 1b is the 400px
// slide-over drawer it opens. Both sit OUT of the content flow (the Agents view keeps
// its stats-then-table) — a persistent, non-blocking checklist derived from live state
// (lib/getting-started.ts). The pill vanishes for good once every item is complete.
//
// Not built yet (no shipped backing — added when their signals land, preset-agents.md
// §3/§6): the "runtime signed in" needs-attention item (probe status, §6.2) and the
// per-item "Ask Assistant" automation (the assistant preset + delegated MCP writes,
// §6.3/§6.4). The footer's "Ask an agent" instead lands on the chat-first Home, the one
// conversational entry that works today.

import { useEffect, useMemo, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useConsoleData } from '@/lib/data-context'
import { isAuthConfigured } from '@/lib/auth'
import { computeGettingStarted, type GsAction } from '@/lib/getting-started'
import {
  AddToSlackRow,
  GsRows,
  MeetYourAgents,
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
  const { agents, integrations, allSessions, orgHasSessions, members, loading } = useConsoleData()
  const { runAction, firstAgent } = useGsActions()
  const pathname = usePathname()
  const authOn = isAuthConfigured()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  // Starts skipped so a skipper never flashes the pill before the stored flag is read
  // (localStorage is client-only, so it can't be read during SSR/first render).
  const [skipped, setSkipped] = useState(true)

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
        integrations,
        sessions: allSessions,
        members,
        authOn,
        orgHasSessions,
        githubLinked,
        githubEnabled,
        sessionAccessAvailable
      }),
    [
      agents,
      integrations,
      allSessions,
      members,
      authOn,
      orgHasSessions,
      githubLinked,
      githubEnabled,
      sessionAccessAvailable
    ]
  )

  // Show on every console page while the checklist is incomplete — including a
  // brand-new org, where setting up the built-in agent is the first open step. The full-screen
  // /onboarding wizard is a separate route (AgentsView redirects an empty org there);
  // the pill only steps aside for that route, not for the empty-org state itself.
  const onOnboardingRoute = pathname?.includes('/onboarding')
  // Gate on the aggregate `loading`, not just agents+daemons: the checklist reads
  // integrations, sessions and members too, so a partial first paint showed the pill
  // with a too-low count that then jumped (and could even flash for an org that is
  // already allDone). One transition, once everything has landed.
  if (loading || onOnboardingRoute) return null
  // The pill is the passive nudge, so it hides once the list is done or skipped. The
  // drawer itself stays renderable — the account menu can pull it back up either way.
  const showPill = !gs.allDone && !skipped
  if (!showPill && !drawerOpen) return null

  const shortLabel = `${gs.done}/${gs.total}`

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
            <Ring ring={gs.ring} size={22} track={3.4} />
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
                <Ring ring={gs.ring} size={26} track={3} />
                <span className="min-w-0 flex-1 font-sans text-[15px] font-semibold leading-normal text-(--text-primary)">
                  Getting started
                </span>
                <span className="font-mono text-[12px] leading-normal text-(--text-tertiary)">
                  {gs.done} of {gs.total}
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
                  style={{ width: `${Math.round(gs.fraction * 100)}%` }}
                />
              </div>
              <div className="mt-[10px] flex items-center gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                <Icon name="info" size={12} className="flex-none" />
                <span className="min-w-0 flex-1">
                  Close it anytime — the checklist stays in the corner until it&rsquo;s done.
                </span>
                <button
                  type="button"
                  onClick={skip}
                  title="Hide the checklist — reopen it from the account menu"
                  className="flex-none cursor-pointer rounded-md border-0 bg-transparent px-[6px] py-[3px] font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary) underline decoration-dotted underline-offset-2 hover:bg-(--surface-hover) hover:text-(--text-primary)"
                >
                  Skip for now
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <GsRows
                items={gs.items}
                expanded={expanded}
                onToggle={(key) => setExpanded((cur) => (cur === key ? null : key))}
                runAction={runFromDrawer}
                renderItem={(it, ctx) =>
                  it.key === 'agent' ? (
                    <MeetYourAgents
                      done={it.done}
                      open={ctx.open}
                      toggle={ctx.toggle}
                      onConnect={() => runFromDrawer(it.action)}
                    />
                  ) : it.key === 'slack' && slackOneClick ? (
                    <AddToSlackRow
                      done={it.done}
                      open={ctx.open}
                      toggle={ctx.toggle}
                      onManual={() => runFromDrawer(it.action)}
                    />
                  ) : null
                }
              />
            </div>

            {firstAgent && (
              <div className="flex flex-none items-center gap-[10px] border-t border-(--border-subtle) bg-(--surface-app) py-[11px] pr-[14px] pl-4">
                <span className="flex-1 font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
                  Stuck on a step? Ask an agent to walk you through it.
                </span>
                <Button variant="secondary" size="sm" onClick={() => runFromDrawer({ kind: 'chat' })}>
                  <span className="inline-flex items-center gap-[6px]">
                    <Icon name="sparkles" size={14} />
                    Ask an agent
                  </span>
                </Button>
              </div>
            )}
          </aside>
        </>
      )}
    </>
  )
}

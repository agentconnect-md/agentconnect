'use client'

// Shared getting-started checklist pieces, so the console pill/drawer (GettingStarted.tsx)
// and the onboarding reveal (OnboardingView.tsx) render the SAME checklist from the SAME
// derivation (lib/getting-started.ts) — the design's explicit goal: onboarding "hands over
// the same getting-started checklist as the console".
//
//   useGsActions() — maps a GsAction (pure, from computeGettingStarted) to the real console
//                    surface that completes it (open a modal, route, open the Playground).
//   <GsRows/>      — the expandable item rows (mark · label · chevron → explanation + CTA).

import { Fragment, type ReactNode } from 'react'
import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useModal } from './ModalProvider'
import { usePlayground } from './PlaygroundProvider'
import type { GsAction, GsItem } from '@/lib/getting-started'
import { Button, Icon } from '@/components/ui'

/** The action-runner + the agent the agent-scoped steps act on, wired to the live console. */
export function useGsActions() {
  const { agents } = useConsoleData()
  const { orgPath } = useOrgs()
  const { openModal } = useModal()
  const { openPlayground } = usePlayground()
  const router = useRouter()
  const firstAgent = agents[0]

  const runAction = useCallback(
    (action: GsAction) => {
      switch (action.kind) {
        case 'daemon':
          return openModal('daemon')
        case 'agent':
          return openModal('agent')
        case 'agentRepo':
          return action.agentId ? router.push(orgPath(`/agents/${action.agentId}`)) : openModal('agent')
        case 'slack':
          return firstAgent ? openModal('integration', firstAgent, { platform: 'slack' }) : openModal('agent')
        case 'github':
          return action.agentId ? router.push(orgPath(`/agents/${action.agentId}`)) : openModal('agent')
        case 'chat':
          return firstAgent ? void openPlayground(firstAgent) : openModal('agent')
        case 'members':
          return router.push(orgPath('/settings'))
      }
    },
    [openModal, openPlayground, router, orgPath, firstAgent]
  )

  return { runAction, firstAgent }
}

// The checklist item rows. `runAction` is supplied by the caller so each surface can
// wrap it (the drawer closes itself first); the wrapper stops the CTA click from
// bubbling to the row's expand/collapse toggle.
export function GsRows({
  items,
  expanded,
  onToggle,
  runAction,
  renderItem
}: {
  items: GsItem[]
  expanded: string | null
  onToggle: (key: string) => void
  runAction: (action: GsAction) => void
  /** Per-item override: return a full custom row for `item` (e.g. onboarding's rich
   *  "Meet your agents" row), or null/undefined to use the default row. */
  renderItem?: (item: GsItem, ctx: { open: boolean; toggle: () => void }) => ReactNode | null
}): ReactNode {
  return items.map((it) => {
    const open = expanded === it.key
    const custom = renderItem?.(it, { open, toggle: () => onToggle(it.key) })
    if (custom != null) return <Fragment key={it.key}>{custom}</Fragment>
    return (
      <div
        key={it.key}
        onClick={() => onToggle(it.key)}
        className="flex cursor-pointer gap-3 border-b border-(--border-subtle) py-3 pr-[14px] pl-4 last:border-b-0 hover:bg-(--surface-hover)"
      >
        <span
          className={`mt-[1px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full ${
            it.done ? 'bg-(--brand) text-white' : 'border-[1.5px] border-(--border-strong)'
          }`}
        >
          {it.done && <Icon name="check" size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <span
            className={`font-sans text-[13.5px] leading-normal ${
              it.done ? 'font-normal text-(--text-tertiary) line-through' : 'font-medium text-(--text-primary)'
            }`}
          >
            {it.label}
          </span>
          {open && (
            <>
              <div className="mt-[5px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {it.expl}
              </div>
              {!it.done && (
                <div className="mt-[11px]" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" onClick={() => runAction(it.action)}>
                    {it.ctaLabel}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
        <span
          className="mt-[2px] flex flex-none text-(--text-tertiary) transition-transform"
          style={{ transform: open ? 'rotate(180deg)' : 'none' }}
        >
          <Icon name="chevron-down" size={15} />
        </span>
      </div>
    )
  })
}

// "Meet your agents" — the design's one-click built-in-agent step (replaces the plain
// "Create your first agent" row) in both the onboarding reveal and the console drawer.
// The two cards are the shipped-later preset agents (preset-agents.md §3): `agentconnect`
// (general) + `agentconnect-admin` (private operator assistant). Until those presets + the
// built-in AgentConnect Bot (§5) exist, this is forward-looking UI: `onConnect` falls back
// to the real create-agent flow (the 'agent' GsAction), and `done` reflects whether a real
// agent exists yet.
// TODO(preset-agents): show the actual placed preset agents and make Connect a one-click
// built-in-Bot bind instead of opening the create-agent modal.
export function MeetYourAgents({
  done,
  open,
  toggle,
  onConnect
}: {
  done: boolean
  open: boolean
  toggle: () => void
  onConnect: () => void
}) {
  return (
    <div
      onClick={toggle}
      className="flex cursor-pointer gap-3 border-b border-(--border-subtle) py-3 pr-[14px] pl-4 last:border-b-0 hover:bg-(--surface-hover)"
    >
      <span
        className={`mt-[1px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full ${
          done ? 'bg-(--brand) text-white' : 'border-[1.5px] border-(--border-strong)'
        }`}
      >
        {done && <Icon name="check" size={12} />}
      </span>
      <div className="min-w-0 flex-1">
        <span className="inline-flex items-center gap-2">
          <span className="font-sans text-[13.5px] font-medium leading-normal text-(--text-primary)">
            Meet your agents
          </span>
          <span className="font-mono text-[11.5px] leading-none text-(--text-disabled)">built-in</span>
        </span>
        {open && (
          <div className="mt-[9px] flex flex-col gap-2">
            {/* agentconnect — general, connectable. Stacked (icon+meta, then action on
                its own row) so it never crams in the 400px drawer. */}
            <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-3 py-[11px]">
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-(--surface-inverse) text-white">
                  <Icon name="bot" size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      agentconnect
                    </span>
                    <span className="flex-none whitespace-nowrap rounded-[5px] bg-(--surface-active) px-[6px] py-[1px] font-sans text-[10px] font-medium leading-normal text-(--text-secondary)">
                      Built-in
                    </span>
                  </div>
                  <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-secondary)">
                    A general agent for coding, code review, and everyday tasks
                  </div>
                </div>
              </div>
              <div className="mt-[10px] flex justify-end" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" onClick={onConnect}>
                  <Icon name="plug" size={14} />
                  Connect
                </Button>
              </div>
            </div>
            {/* agentconnect-admin — private operator assistant, no channel */}
            <div className="rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-3 py-[11px]">
              <div className="flex items-start gap-3">
                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-(--surface-inverse) text-white">
                  <Icon name="bot" size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                      agentconnect-admin
                    </span>
                    <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      <Icon name="lock" size={12} />
                      Private to you
                    </span>
                  </div>
                  <div className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-secondary)">
                    Helps you set up and operate AgentConnect
                  </div>
                </div>
              </div>
              {/* Mirrors the Connect button's slot on the card above: same row, same size. */}
              <div className="mt-[10px] flex justify-end">
                <span className="inline-flex h-[30px] items-center gap-[6px] whitespace-nowrap rounded-(--radius-sm) border border-(--border-subtle) bg-(--surface-card) px-3 font-sans text-[12.5px] leading-none text-(--text-tertiary)">
                  <Icon name="check" size={14} />
                  No channel needed
                </span>
              </div>
            </div>
            <div className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
              One click uses the built-in AgentConnect Bot — no Slack app, no token, no scopes to pick.
            </div>
          </div>
        )}
      </div>
      <span
        className="mt-[2px] flex flex-none text-(--text-tertiary) transition-transform"
        style={{ transform: open ? 'rotate(180deg)' : 'none' }}
      >
        <Icon name="chevron-down" size={15} />
      </span>
    </div>
  )
}

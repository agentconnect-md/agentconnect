'use client'

// The one state icon sessions, tasks, follow-ups, subagents, commands and steps share: a 10px solid dot that leads its row.

import { Icon } from '@/components/ui'

export type StateKind = 'running' | 'idle' | 'waiting' | 'done' | 'failed'

const FILL: Record<StateKind, string> = {
  running: 'bg-(--status-online) animate-[stateBlink_1.6s_ease-in-out_infinite] motion-reduce:animate-none',
  idle: 'bg-(--status-idle)',
  waiting: 'bg-(--status-info)',
  done: 'bg-(--text-tertiary) text-(--surface-card)',
  failed: 'bg-(--status-error)'
}

/** `label` names the state for a screen reader and as the hover tip, since the dot alone carries it. */
export function StateIcon({ state, label, className = '' }: { state: StateKind; label: string; className?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-state-icon={state}
      className={`relative m-[2px] flex h-[10px] w-[10px] flex-none items-center justify-center rounded-full ${FILL[state]} ${className}`}
    >
      {state === 'done' ? <Icon name="check" size={7} strokeWidth={3} /> : null}
      {state === 'waiting' ? (
        <>
          {/* A clock's two hands, drawn in white over the blue. */}
          <span aria-hidden className="absolute top-[2px] left-[4.35px] h-[3.4px] w-[1.3px] rounded-[1px] bg-white" />
          <span aria-hidden className="absolute top-[4.1px] left-[4.35px] h-[1.3px] w-[2.8px] rounded-[1px] bg-white" />
        </>
      ) : null}
    </span>
  )
}

/** A session's state from its raw status and whether a turn streams here: a raw `prompting` or `cancelling` is running too. */
export function sessionState(raw: string, busy: boolean): StateKind {
  const s = raw.toLowerCase()
  if (busy || s === 'prompting' || s === 'cancelling' || s === 'running') return 'running'
  if (s === 'error' || s === 'failed') return 'failed'
  return 'idle'
}

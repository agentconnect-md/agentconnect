'use client'

// A composer's send / stop control: send is a small brand square with an arrow, stop a plain square; both sit on a quiet button.

import type { ButtonHTMLAttributes } from 'react'
import { Icon } from '@/components/ui'

export function SendButton({
  stop = false,
  label,
  className = '',
  ...rest
}: {
  /** The turn is running and nothing is drafted, so the control stops it instead. */
  stop?: boolean
  label: string
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children'>) {
  return (
    <button
      type="button"
      aria-label={label}
      data-send-button={stop ? 'stop' : 'send'}
      // `sendbtn` names the control for tests and callers; its look is the utilities here.
      className={`sendbtn group/send flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[8px] border-0 bg-transparent text-(--text-primary) transition-colors hover:enabled:bg-(--surface-hover) disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {stop ? (
        <Icon name="square" size={15} />
      ) : (
        <span className="flex h-4 w-4 items-center justify-center rounded-[4px] bg-(--brand) text-white group-disabled/send:bg-(--border-strong)">
          <Icon name="arrow-up" size={11} strokeWidth={3} />
        </span>
      )}
    </button>
  )
}

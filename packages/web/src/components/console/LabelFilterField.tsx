'use client'

import { useId, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Icon } from '@/components/ui'

/** The Control Plane's cap on one row's label filter. */
export const LABEL_FILTER_MAX = 20
const LABEL_MAX_LENGTH = 100

/** Add typed labels to a filter: trimmed, capped at 100 characters, deduplicated case-insensitively (the relay matches that way), never past the cap. */
export function addLabels(current: readonly string[], typed: readonly string[], max = LABEL_FILTER_MAX): string[] {
  const next = [...current]
  const seen = new Set(current.map((label) => label.toLowerCase()))
  for (const raw of typed) {
    const label = raw.trim().slice(0, LABEL_MAX_LENGTH)
    if (!label || seen.has(label.toLowerCase()) || next.length >= max) continue
    seen.add(label.toLowerCase())
    next.push(label)
  }
  return next
}

// "Only with labels" — the chip field the row settings dialog and the create cards share. Enter commits
// the typed label (labels may contain commas, so only a PASTED list splits on them), Backspace on an
// empty input removes the last chip, and the cap hides the input behind a note. `collapsible` is the
// create card's form: a "Filter by labels" link until it is opened or a value exists.
export function LabelFilterField({
  value,
  onChange,
  collapsible = false
}: {
  value: readonly string[]
  onChange: (labels: string[]) => void
  collapsible?: boolean
}) {
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [opened, setOpened] = useState(false)
  const atCap = value.length >= LABEL_FILTER_MAX

  const commit = (typed: readonly string[]) => {
    const next = addLabels(value, typed)
    if (next.length !== value.length) onChange(next)
    setDraft('')
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (draft.trim()) commit([draft])
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      event.preventDefault()
      onChange(value.slice(0, -1))
    }
  }
  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text')
    if (!/[,\n]/.test(text)) return
    event.preventDefault()
    commit(`${draft}${text}`.split(/[,\n]/))
  }

  if (collapsible && !opened && value.length === 0) {
    return (
      <div className="flex h-8 items-center" data-label-filter="collapsed">
        <button type="button" className="lnk text-[11.5px]" onClick={() => setOpened(true)}>
          <Icon name="tag" size={12} />
          Filter by labels
        </button>
      </div>
    )
  }
  return (
    <div data-label-filter="open">
      <div className="mb-[6px] flex items-center">
        <label htmlFor={inputId} className="fldlbl">
          Only with labels
        </label>
        <span
          className={`ml-auto font-mono text-[11px] font-medium leading-normal ${
            atCap ? 'text-(--amber-500)' : 'text-(--text-tertiary)'
          }`}
        >
          {value.length}/{LABEL_FILTER_MAX}
        </span>
      </div>
      <div className="inp flex-wrap justify-start gap-[6px] px-2 py-[5px]">
        {value.map((label) => (
          <span
            key={label}
            className="inline-flex items-center gap-[5px] rounded-xs border border-(--border-subtle) bg-(--surface-sunken) py-[3px] pr-[5px] pl-[7px] font-mono text-[11.5px] font-medium leading-normal whitespace-nowrap text-(--text-secondary)"
          >
            {label}
            <button
              type="button"
              aria-label={`Remove label ${label}`}
              className="flex text-(--text-tertiary) hover:text-(--text-primary)"
              onClick={() => onChange(value.filter((other) => other !== label))}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {!atCap && (
          <input
            id={inputId}
            aria-label="Add a label"
            autoFocus={collapsible}
            value={draft}
            placeholder={value.length > 0 ? 'add another…' : 'type a label, Enter adds it'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => {
              if (draft.trim()) commit([draft])
            }}
            className="min-w-[110px] flex-1 border-0 bg-transparent p-[2px] font-mono text-[12px] font-normal leading-normal text-(--text-primary) outline-none placeholder:text-(--text-disabled)"
          />
        )}
      </div>
      {atCap && (
        <div className="mt-[7px] flex items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--amber-500)">
          <Icon name="triangle-alert" size={12} className="flex-none" />
          Label limit reached — remove one to add another.
        </div>
      )}
    </div>
  )
}

'use client'

// The Try state drawn as its JSON: punctuation and keys read-only, the fields a sample varies as inputs in place.

import type { ReactNode } from 'react'
import { Icon } from '@/components/ui'

function Key({ name }: { name?: string }) {
  if (name === undefined) return null
  return <span className="flex-none text-(--text-secondary)">&quot;{name}&quot;:</span>
}

const P = ({ children }: { children: ReactNode }) => (
  <span className="flex-none text-(--text-tertiary)">{children}</span>
)

function IconButton({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-[20px] w-[20px] flex-none items-center justify-center rounded-xs border-0 bg-transparent text-(--text-tertiary) hover:bg-(--surface-hover) hover:text-(--text-primary)"
    >
      <Icon name={icon} size={13} />
    </button>
  )
}

/** The whole state: a monospace frame whose root object the lane's fields fill. */
export function StateJson({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="overflow-x-auto rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[9px] font-mono text-[12px] font-normal leading-[1.7]"
    >
      <P>{'{'}</P>
      <div className="pl-4">{children}</div>
      <P>{'}'}</P>
    </div>
  )
}

/** The fields this consumer fills in itself, folded; hovering names them. */
export function JsonFold({ title }: { title: string }) {
  return (
    <div title={title} aria-label={title} className="w-fit cursor-default text-(--text-tertiary)">
      …
    </div>
  )
}

export function JsonObject({
  name,
  children,
  action,
  inline = false
}: {
  name?: string
  children: ReactNode
  /** A control on the opening line, such as Remove for an array item. */
  action?: ReactNode
  /** Short objects, such as a sender, stay on one line. */
  inline?: boolean
}) {
  if (inline)
    return (
      <div className="flex flex-wrap items-center gap-x-[6px]">
        <Key name={name} />
        <P>{'{'}</P>
        {children}
        <P>{'}'}</P>
        {action}
      </div>
    )
  return (
    <div>
      <div className="flex items-center gap-[6px]">
        <Key name={name} />
        <P>{'{'}</P>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="flex flex-col pl-4">{children}</div>
      <P>{'}'}</P>
    </div>
  )
}

export function JsonArray({
  name,
  children,
  count,
  onAdd,
  addLabel
}: {
  name: string
  children?: ReactNode
  count: number
  onAdd?: () => void
  addLabel?: string
}) {
  const add = onAdd && addLabel ? <IconButton icon="plus" label={addLabel} onClick={onAdd} /> : null
  if (count === 0)
    return (
      <div className="flex items-center gap-[6px]">
        <Key name={name} />
        <P>[]</P>
        {add}
      </div>
    )
  return (
    <div>
      <div className="flex items-center gap-[6px]">
        <Key name={name} />
        <P>[</P>
        {add}
      </div>
      <div className="flex flex-col gap-[2px] pl-4">{children}</div>
      <P>]</P>
    </div>
  )
}

export function JsonRemove({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <IconButton icon="trash" label={label} onClick={onRemove} />
}

/** A value the sample varies: prose in the sans face, growing with its lines. */
export function JsonText({
  name,
  value,
  onChange,
  label,
  placeholder,
  maxRows = 8
}: {
  name: string
  value: string
  onChange: (next: string) => void
  label: string
  placeholder?: string
  maxRows?: number
}) {
  return (
    <div className="flex items-start gap-[6px]">
      <span className="pt-[3px]">
        <Key name={name} />
      </span>
      <textarea
        value={value}
        rows={Math.min(maxRows, Math.max(1, value.split('\n').length))}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        className="inp my-[2px] block min-h-0 min-w-[160px] flex-1 resize-y px-[8px] py-[3px] font-sans text-[12.5px] font-normal leading-[1.5]"
      />
    </div>
  )
}

/** A value that rarely matters, such as an id: small and quiet until focused. */
export function JsonTag({
  name,
  value,
  onChange,
  label,
  numeric = false,
  placeholder
}: {
  name: string
  value: string
  onChange: (next: string) => void
  label: string
  numeric?: boolean
  placeholder?: string
}) {
  return (
    <span className="inline-flex items-center gap-[6px]">
      <Key name={name} />
      <input
        value={value}
        // Monospace: one `ch` per character, so the field hugs its value.
        style={{ width: `${Math.max(2, (value || placeholder || '').length)}ch` }}
        inputMode={numeric ? 'numeric' : undefined}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="mono box-content h-[20px] min-w-0 rounded-xs border border-transparent bg-transparent px-[3px] text-[11.5px] text-(--text-tertiary) hover:border-(--border-subtle) focus:border-(--border-strong) focus:text-(--text-primary) focus:outline-none"
      />
    </span>
  )
}

/** A fixed value, shown as the JSON it is. */
export function JsonLiteral({ name, value }: { name: string; value: unknown }) {
  return (
    <div className="flex items-center gap-[6px]">
      <Key name={name} />
      <span className="text-(--text-tertiary)">{JSON.stringify(value)}</span>
    </div>
  )
}

export function JsonBoolean({
  name,
  value,
  onChange,
  label
}: {
  name: string
  value: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <label className="flex w-fit items-center gap-[6px]">
      <Key name={name} />
      <input type="checkbox" checked={value} aria-label={label} onChange={(event) => onChange(event.target.checked)} />
      <span className="text-(--text-tertiary)">{String(value)}</span>
    </label>
  )
}

/** Agent ids picked by name among `agents`; the state keeps the ids. */
export function JsonAgents({
  name,
  ids,
  agents,
  onChange,
  addLabel,
  addText,
  removeLabel
}: {
  name: string
  ids: readonly string[]
  agents: ReadonlyArray<{ id: string; name: string }>
  onChange: (next: string[]) => void
  addLabel: string
  /** The picker's own short prompt. */
  addText: string
  removeLabel: (agent: string) => string
}) {
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.name ?? id
  const rest = agents.filter((agent) => !ids.includes(agent.id))
  return (
    <div className="flex flex-wrap items-center gap-[6px]">
      <Key name={name} />
      <P>[</P>
      {ids.map((id) => (
        <span
          key={id}
          title={id}
          className="inline-flex items-center gap-[3px] rounded-full border border-(--border-subtle) bg-(--surface-card) py-0 pl-[8px] pr-[2px] font-sans text-[11.5px] font-medium leading-[1.6] text-(--text-primary)"
        >
          {nameOf(id)}
          <IconButton icon="x" label={removeLabel(nameOf(id))} onClick={() => onChange(ids.filter((x) => x !== id))} />
        </span>
      ))}
      {rest.length > 0 && (
        <select
          aria-label={addLabel}
          value=""
          onChange={(event) => event.target.value && onChange([...ids, event.target.value])}
          className="h-[20px] rounded-xs border border-dashed border-(--border-subtle) bg-transparent px-1 font-sans text-[11.5px] text-(--text-tertiary)"
        >
          <option value="">+ {addText}</option>
          {rest.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      )}
      <P>]</P>
    </div>
  )
}

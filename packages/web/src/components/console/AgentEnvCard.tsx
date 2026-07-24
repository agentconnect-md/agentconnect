'use client'

import { useState } from 'react'
import { MOCK_PREFIX, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'

// Mirrors the CP's env-key rule (dto AgentEnvBody) so a bad name fails inline
// instead of as a PATCH 400.
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
// Collapse the view-mode list past this many rows behind a "Show all" toggle.
const COLLAPSE_AT = 6
// Compact mono field chrome (design: mono 12px, brand focus ring), mirrored in
// the secrets card.
const EDIT_FIELD =
  'w-full min-w-0 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] font-mono text-[12px] font-medium text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)'
const EDIT_INPUT = `h-7 ${EDIT_FIELD}`
// Values may be multi-line (a PEM block, a JSON blob) and a single-line <input>
// collapses pasted newlines before React ever sees them — the value editor is a
// textarea, same as the secrets card.
const EDIT_VALUE = `min-h-14 resize-y py-[5px] leading-[1.5] ${EDIT_FIELD}`

type EnvRow = { k: string; v: string }

/**
 * The config tab's "Environment variables" card. View mode lists the agent's
 * env (spec `env`, injected into the runtime by the daemon), collapsing a long
 * list behind "Show all"; Edit turns the rows into stacked key/value inputs and
 * Done PATCHes the full record — env is replaced wholesale on the CP. Mock agents
 * keep their static demo rows (no editing). Secrets are the sibling card.
 */
export function AgentEnvCard({ agent }: { agent: Agent }) {
  const { updateAgent } = useConsoleData()
  const editable = !agent.name.startsWith(MOCK_PREFIX)
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<EnvRow[]>([])
  const [showAll, setShowAll] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const startEdit = () => {
    setRows(agent.env.map((e) => ({ ...e })))
    setErr(null)
    setEditing(true)
  }

  const setRow = (i: number, patch: Partial<EnvRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i))

  const save = async () => {
    if (saving) return
    // Fully blank rows are just abandoned "Add variable" clicks — drop them.
    const kept = rows.map((r) => ({ k: r.k.trim(), v: r.v })).filter((r) => r.k || r.v)
    const bad = kept.find((r) => !ENV_KEY.test(r.k))
    if (bad) {
      setErr(`"${bad.k || '(empty)'}" is not a valid variable name — use letters, digits and _`)
      return
    }
    if (new Set(kept.map((r) => r.k)).size !== kept.length) {
      setErr('Duplicate variable names')
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agent.id, { env: Object.fromEntries(kept.map((r) => [r.k, r.v])) })
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const total = agent.env.length
  const collapsed = !editing && !showAll && total > COLLAPSE_AT
  const visible = collapsed ? agent.env.slice(0, COLLAPSE_AT) : agent.env

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">Environment variables</span>
          {total > 0 && <span className="mono text-[11px] text-(--text-tertiary)">{total}</span>}
        </span>
        {editable && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => (editing ? void save() : startEdit())}
            className={saving ? 'cursor-default opacity-50' : undefined}
          >
            <Icon name={editing ? 'check' : 'pencil'} size={14} />
            {editing ? (saving ? 'Saving…' : 'Done') : 'Edit'}
          </Button>
        )}
      </div>
      <div className="py-1">
        {!editing &&
          visible.map((e, i) => (
            <div key={i} className="row grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 px-4 py-[10px]">
              <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={e.k}>
                {e.k}
              </span>
              <span className="mono min-w-0 truncate text-right text-[12px] text-(--text-tertiary)" title={e.v}>
                {e.v}
              </span>
            </div>
          ))}
        {!editing && total === 0 && (
          <div className="px-4 py-[11px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No environment variables
          </div>
        )}
        {collapsed && (
          <button className="lnk w-full px-4 py-[9px] text-left text-[12px]" onClick={() => setShowAll(true)}>
            Show all {total}
            <Icon name="chevron-down" size={13} />
          </button>
        )}
        {!editing && showAll && total > COLLAPSE_AT && (
          <button className="lnk w-full px-4 py-[9px] text-left text-[12px]" onClick={() => setShowAll(false)}>
            Show less
            <Icon name="chevron-up" size={13} />
          </button>
        )}
        {editing && (
          <>
            {rows.map((r, i) => (
              <div
                key={i}
                className="flex flex-col gap-[6px] border-b border-(--border-subtle) px-4 pt-[9px] pb-[11px]"
              >
                <div className="flex items-center gap-[6px]">
                  <input
                    className={EDIT_INPUT}
                    placeholder="KEY"
                    value={r.k}
                    onChange={(e) => setRow(i, { k: e.target.value })}
                    aria-label="Variable name"
                  />
                  <button className="iconbtn h-7 w-7 flex-none" title="Remove" onClick={() => removeRow(i)}>
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <textarea
                  className={EDIT_VALUE}
                  placeholder="Value"
                  value={r.v}
                  onChange={(e) => setRow(i, { v: e.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="Variable value"
                />
              </div>
            ))}
            <button
              className="lnk px-4 pt-[10px] pb-2 text-[12.5px]"
              onClick={() => setRows((rs) => [...rs, { k: '', v: '' }])}
            >
              <Icon name="plus" size={13} />
              Add variable
            </button>
          </>
        )}
        {err && (
          <div className="flex items-center gap-[7px] px-4 py-[9px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={13} />
            {err}
          </div>
        )}
      </div>
    </div>
  )
}

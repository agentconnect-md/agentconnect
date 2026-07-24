'use client'

import { useState } from 'react'
import { MOCK_PREFIX, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'

// Mirrors the CP's secret-key rule (dto AgentSecretsPatchBody) so a bad name fails
// inline instead of as a PATCH 400.
const SECRET_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
// Compact mono field chrome, shared with the env card (mono 12px, brand focus ring).
const EDIT_FIELD =
  'w-full min-w-0 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] font-mono text-[12px] font-medium text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)'
const EDIT_INPUT = `h-7 ${EDIT_FIELD}`
// Secret values may be whole config files (the *_DATA config-file secrets — a
// kubeconfig, a docker config.json), and a single-line <input> collapses pasted
// newlines before React ever sees them. The value editor is therefore a plain
// textarea — GitHub-Actions-style: visible while editing, write-only after save.
const EDIT_VALUE = `min-h-14 resize-y py-[5px] leading-[1.5] ${EDIT_FIELD}`

// One editable row. `origK` is the stored name for a row that came from an existing
// secret (null for a freshly-added one); `reveal` shows the value input (always on
// for new/replaced secrets, off for an untouched existing secret shown masked).
type SecRow = { k: string; origK: string | null; v: string; reveal: boolean }

/**
 * The config tab's "Secrets" card — write-only secret env vars. View mode lists the
 * agent's secret NAMES (values are never returned by the API), each shown masked.
 * Edit lets you add, replace, or remove secrets; on Done it sends only the changes
 * (a key→value sets/replaces, a removed key clears it — see the CP's key-by-key
 * merge). Mock agents are read-only. Sibling of {@link AgentEnvCard}.
 */
export function AgentSecretsCard({ agent }: { agent: Agent }) {
  const { updateAgent } = useConsoleData()
  const editable = !agent.name.startsWith(MOCK_PREFIX)
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<SecRow[]>([])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const startEdit = () => {
    setRows(agent.secretKeys.map((k) => ({ k, origK: k, v: '', reveal: false })))
    setErr(null)
    setEditing(true)
  }

  const setRow = (i: number, patch: Partial<SecRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const removeRow = (i: number) => setRows((rs) => rs.filter((_, j) => j !== i))
  // Editing an existing secret's key is a rename → it needs a fresh value, so reveal
  // the value input (the stored value can't be carried forward — it's write-only).
  const setKey = (i: number, k: string) =>
    setRows((rs) =>
      rs.map((r, j) => (j === i ? { ...r, k, reveal: r.reveal || (r.origK !== null && k !== r.origK) } : r))
    )

  const save = async () => {
    if (saving) return
    // Drop untouched blank new rows (an abandoned "Add secret" click).
    const kept = rows.map((r) => ({ ...r, k: r.k.trim() })).filter((r) => !(r.origK === null && !r.k && !r.v))

    for (const r of kept) {
      if (!SECRET_KEY.test(r.k)) {
        setErr(`"${r.k || '(empty)'}" is not a valid secret name — use letters, digits and _`)
        return
      }
      // A revealed row (new secret, replacement, or rename) must carry a value —
      // there's nothing to fall back to for it.
      if (r.reveal && r.v === '') {
        setErr(`Enter a value for "${r.k}"`)
        return
      }
    }
    if (new Set(kept.map((r) => r.k)).size !== kept.length) {
      setErr('Duplicate secret names')
      return
    }

    // Build the key-by-key patch: set/replace revealed rows, delete any original key
    // no longer present (removed or renamed away); leave untouched keys out entirely.
    const patch: Record<string, string | null> = {}
    const keptKeys = new Set(kept.map((r) => r.k))
    for (const r of kept) if (r.reveal) patch[r.k] = r.v
    for (const ok of agent.secretKeys) if (!keptKeys.has(ok)) patch[ok] = null

    if (Object.keys(patch).length === 0) {
      setEditing(false) // nothing changed — skip the no-op PATCH
      return
    }
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agent.id, { secrets: patch })
      setEditing(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const total = agent.secretKeys.length

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">Secrets</span>
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
          agent.secretKeys.map((k, i) => (
            <div key={i} className="row grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-[10px]">
              <span className="flex min-w-0 items-center gap-[7px]">
                <Icon name="lock" size={11} color="var(--text-tertiary)" className="flex-none" />
                <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={k}>
                  {k}
                </span>
              </span>
              <span className="mono text-[12px] text-(--text-tertiary)" title="Write-only — value can't be viewed">
                ••••••••
              </span>
            </div>
          ))}
        {!editing && total === 0 && (
          <div className="px-4 py-[11px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            No secrets
          </div>
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
                    placeholder="SECRET_KEY"
                    value={r.k}
                    onChange={(e) => setKey(i, e.target.value)}
                    aria-label="Secret name"
                  />
                  <button className="iconbtn h-7 w-7 flex-none" title="Remove" onClick={() => removeRow(i)}>
                    <Icon name="x" size={13} />
                  </button>
                </div>
                {r.reveal ? (
                  <textarea
                    className={EDIT_VALUE}
                    placeholder={r.origK !== null ? 'New value' : 'Value'}
                    value={r.v}
                    onChange={(e) => setRow(i, { v: e.target.value })}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="Secret value"
                  />
                ) : (
                  <div className="flex h-7 items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-[9px]">
                    <span className="mono text-[12px] text-(--text-tertiary)">••••••••</span>
                    <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      write-only
                    </span>
                    <button className="lnk ml-auto text-[11.5px]" onClick={() => setRow(i, { reveal: true })}>
                      Replace
                    </button>
                  </div>
                )}
              </div>
            ))}
            <button
              className="lnk px-4 pt-[10px] pb-[2px] text-[12.5px]"
              onClick={() => setRows((rs) => [...rs, { k: '', origK: null, v: '', reveal: true }])}
            >
              <Icon name="plus" size={13} />
              Add secret
            </button>
            <div className="px-4 pt-2 pb-[10px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
              Values are write-only — they can’t be viewed after saving.
            </div>
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

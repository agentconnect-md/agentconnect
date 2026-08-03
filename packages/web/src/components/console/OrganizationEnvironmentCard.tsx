'use client'

// Settings → "Variables & secrets": the organization environment registry
// (docs/designs/organization-secrets-and-variables.md §8.1). An owner defines a
// variable or secret ONCE and targets it at every agent or a chosen set; the
// Control Plane resolves it into each agent's effective env/secrets.
//
// Three product rules this component exists to hold:
//
//  1. Secret values are WRITE-ONLY. Saved secrets render as a fixed mask, and the
//     edit sheet's value field starts empty and is labeled "Replace value" —
//     leaving it empty keeps the stored value. Nothing here can read one back.
//
//  2. The agent picker shows only agents the viewer can MANAGE, and says so. An
//     entry may also be assigned to private agents the viewer cannot see; editing
//     the visible selection never touches those, and the copy deliberately does not
//     reveal whether any exist.
//
//  3. Deleting, rotating, and switching to "All agents" confirm first and describe
//     the actual runtime effect — including that a process already running keeps an
//     old value until its next safe restart point. The UI never claims otherwise.
//
// Bindings are edited ONE AGENT AT A TIME against the idempotent per-agent
// endpoints, so two owners adding different agents cannot overwrite each other.

import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import {
  assignOrganizationEnvironmentEntry,
  createOrganizationEnvironmentEntry,
  deleteOrganizationEnvironmentEntry,
  fetchOrganizationEnvironment,
  unassignOrganizationEnvironmentEntry,
  updateOrganizationEnvironmentEntry,
  type OrganizationEnvironmentAudience,
  type OrganizationEnvironmentEntryDto,
  type OrganizationEnvironmentKind
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import type { Agent } from '@/lib/data'
import { Button, Icon } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { LoadingState } from '@/components/marks'

/** Same rule as the CP's ENV_VAR_NAME, so a bad name fails inline, not as a 400. */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The one place the standing picker disclosure is worded (§8.1). */
const PICKER_HELP =
  'Only agents you can manage are shown. Existing assignments to other private agents are left unchanged.'

const FIELD =
  'w-full min-w-0 rounded-md border border-(--border-default) bg-(--surface-card) px-[9px] font-mono text-[12px] font-medium text-(--text-primary) outline-none focus:border-(--border-focus) focus:ring-[3px] focus:ring-(--brand-ring)'
const INPUT = `h-8 ${FIELD}`
// Values may be multi-line (a PEM block, a kubeconfig, a JSON blob), and a
// single-line input collapses pasted newlines.
const TEXTAREA = `min-h-16 resize-y py-[6px] leading-[1.5] ${FIELD}`
const LABEL = 'font-sans text-[12px] font-semibold leading-normal text-(--text-primary)'
const HELP = 'font-sans text-[11.5px] font-normal leading-[1.45] text-(--text-tertiary)'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What the sheet is editing: a fresh entry, or an existing one. */
type SheetTarget = { mode: 'create' } | { mode: 'edit'; entry: OrganizationEnvironmentEntryDto }

export function OrganizationEnvironmentCard({
  orgId,
  isOwner,
  agents
}: {
  orgId: string | undefined
  /** Non-owners never see the registry at all — it is owner-only by design (§4). */
  isOwner: boolean
  /** The org's agents as the viewer sees them; the picker filters to `canEdit`. */
  agents: Agent[]
}) {
  const key = isOwner ? consoleKeys.organizationEnvironment(orgId) : null
  const {
    data: entries,
    error: loadError,
    mutate
  } = useSWR<OrganizationEnvironmentEntryDto[]>(key, ([, id]) => fetchOrganizationEnvironment(id as string))
  const [sheet, setSheet] = useState<SheetTarget | null>(null)
  const [deleting, setDeleting] = useState<OrganizationEnvironmentEntryDto | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    setSheet(null)
    setDeleting(null)
    setDeleteError(null)
  }, [orgId])

  if (!isOwner) return null

  const manageable = agents.filter((agent) => agent.canEdit)

  const confirmDelete = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteOrganizationEnvironmentEntry(deleting.id)
      setDeleting(null)
      await mutate()
    } catch (err) {
      setDeleteError(errorMessage(err))
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className="card mt-[18px]">
      <div className="cardhead justify-between">
        <span className="inline-flex min-w-0 items-baseline gap-[7px]">
          <span className="cardtitle">Variables &amp; secrets</span>
          {entries && entries.length > 0 && (
            <span className="mono text-[11px] text-(--text-tertiary)">{entries.length}</span>
          )}
        </span>
        <Button variant="secondary" size="xs" onClick={() => setSheet({ mode: 'create' })}>
          <Icon name="plus" size={14} />
          Add
        </Button>
      </div>

      <div className="px-4 pb-[2px] pt-[13px]">
        <div className={HELP}>
          Define a value once and apply it to every agent or a chosen set. Assigned rows appear on each agent&apos;s
          Variables and Secrets cards, where they are read-only.
        </div>
      </div>

      {entries === undefined && !loadError ? (
        <LoadingState size={22} padding={20} />
      ) : loadError ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
          Couldn&apos;t load the organization variables and secrets.
        </div>
      ) : !entries || entries.length === 0 ? (
        <div className="px-4 py-[15px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No organization variables or secrets yet.
        </div>
      ) : (
        <div className="py-1">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              onEdit={() => setSheet({ mode: 'edit', entry })}
              onDelete={() => {
                setDeleteError(null)
                setDeleting(entry)
              }}
            />
          ))}
        </div>
      )}

      {sheet && (
        <EntrySheet
          target={sheet}
          manageableAgents={manageable}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null)
            await mutate()
          }}
          onBindingsChanged={() => void mutate()}
        />
      )}

      {deleting && (
        <ConfirmationDialog
          title={`Delete ${deleting.key}?`}
          confirmLabel="Delete"
          busy={deleteBusy}
          busyLabel="Deleting…"
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={() => (deleteBusy ? undefined : setDeleting(null))}
        >
          Every agent this {deleting.kind === 'secret' ? 'secret' : 'variable'} was assigned to stops receiving it. If
          an agent defines its own <span className="mono">{deleting.key}</span>, that value becomes effective again.
          {deleting.kind === 'secret' && ' The value cannot be recovered afterwards.'}
          <RunningProcessNote />
        </ConfirmationDialog>
      )}
    </div>
  )
}

/**
 * The honest statement about revocation timing (§7). Agent hosts are replaced at a
 * safe point in the background-task-aware lifecycle, so a value already handed to a
 * running process cannot be clawed back — and the UI must not imply it was.
 */
function RunningProcessNote() {
  return (
    <span className="mt-[10px] block font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
      Agents pick this up when their runtime is next restarted. A process already running keeps the old value until
      then.
    </span>
  )
}

function EntryRow({
  entry,
  onEdit,
  onDelete
}: {
  entry: OrganizationEnvironmentEntryDto
  onEdit: () => void
  onDelete: () => void
}) {
  const secret = entry.kind === 'secret'
  return (
    <div className="flex flex-col gap-[6px] px-4 py-[10px] desktop:flex-row desktop:items-center desktop:gap-3">
      <span className="flex min-w-0 items-center gap-[7px] desktop:flex-1">
        {secret && <Icon name="lock" size={11} color="var(--text-tertiary)" className="flex-none" />}
        <span className="mono min-w-0 truncate text-[12px] text-(--text-primary)" title={entry.key}>
          {entry.key}
        </span>
        <span className="badge flex-none bg-(--surface-active) text-(--text-secondary)">
          {secret ? 'Secret' : 'Variable'}
        </span>
      </span>
      <span
        className="mono min-w-0 truncate text-[12px] text-(--text-tertiary) desktop:flex-1 desktop:text-right"
        title={secret ? 'Write-only — value can’t be viewed' : entry.variableValue}
      >
        {secret ? '••••••••' : entry.variableValue}
      </span>
      <span className="flex items-center gap-3">
        <span className="flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {entry.audience === 'all' ? 'All agents' : `Selected agents (${entry.visibleAgentIds.length})`}
        </span>
        <span className="ml-auto flex flex-none items-center gap-1 desktop:ml-0">
          <button type="button" className="iconbtn h-[26px] w-[26px]" title="Edit" onClick={onEdit}>
            <Icon name="pencil" size={12} />
          </button>
          <button type="button" className="iconbtn h-[26px] w-[26px]" title="Delete" onClick={onDelete}>
            <Icon name="trash-2" size={12} />
          </button>
        </span>
      </span>
    </div>
  )
}

/**
 * Add/edit sheet. On CREATE everything is submitted in one request. On EDIT the
 * value/audience save and the per-agent bindings are separate operations by
 * design: bindings go straight to the idempotent per-agent endpoints so a
 * concurrent owner adding a different agent is never overwritten, and so an
 * invisible private-agent binding cannot be destroyed by submitting an array.
 */
function EntrySheet({
  target,
  manageableAgents,
  onClose,
  onSaved,
  onBindingsChanged
}: {
  target: SheetTarget
  manageableAgents: Agent[]
  onClose: () => void
  onSaved: () => Promise<void>
  onBindingsChanged: () => void
}) {
  const editing = target.mode === 'edit' ? target.entry : null
  const [key, setKey] = useState(editing?.key ?? '')
  const [kind, setKind] = useState<OrganizationEnvironmentKind>(editing?.kind ?? 'variable')
  const [value, setValue] = useState(editing?.kind === 'variable' ? (editing.variableValue ?? '') : '')
  const [audience, setAudience] = useState<OrganizationEnvironmentAudience>(editing?.audience ?? 'selected')
  // Local create-time selection only. While editing, each toggle is committed
  // immediately through the per-agent endpoints (see `toggleBinding`).
  const [selected, setSelected] = useState<string[]>(editing?.visibleAgentIds ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when a destructive/broadening save needs an explicit confirmation first.
  const [pendingConfirm, setPendingConfirm] = useState<'all' | 'rotate' | null>(null)
  const [bindingBusy, setBindingBusy] = useState<string | null>(null)
  // `version` advances on every server-accepted save; the next PATCH must fence on
  // the CURRENT one or the CP returns 409.
  const [version, setVersion] = useState(editing?.version ?? 0)

  const secret = kind === 'secret'
  // Whether this save SENDS a value. A variable always does, a create always does,
  // and a saved secret only once the owner explicitly chose to replace it — so the
  // empty string is a settable value rather than a "leave unchanged" sentinel.
  const [replaceMode, setReplaceMode] = useState(editing === null || editing.kind === 'variable')
  /** A saved secret whose value the owner has not chosen to touch. */
  const savedSecretKept = editing !== null && secret && !replaceMode
  const replacingSavedSecret = editing !== null && secret && replaceMode
  const wideningToAll = audience === 'all' && editing?.audience !== 'all'

  const validation = useMemo(() => {
    const trimmed = key.trim()
    if (!ENV_KEY.test(trimmed)) return `“${trimmed || '(empty)'}” is not a valid name`
    // A brand-new secret must carry a value — the same guard the agent-level secret
    // editor applies. Rotating a SAVED secret to the empty string is allowed, since
    // "replace" is now an explicit action rather than an inference from the field.
    if (!editing && secret && value === '') return 'Enter a value for the secret'
    return null
  }, [editing, key, secret, value])

  const save = async () => {
    if (busy || validation) return
    // Broadening the audience and rotating a secret both change what running
    // agents receive, so both confirm before the request goes out.
    if (!pendingConfirm && (wideningToAll || replacingSavedSecret)) {
      setPendingConfirm(wideningToAll ? 'all' : 'rotate')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        const updated = await updateOrganizationEnvironmentEntry(editing.id, {
          expectedVersion: version,
          // Omitting `value` is what leaves the stored one unchanged, and that now
          // happens only when the owner did NOT ask to replace it — so an
          // intentional empty string is sent through.
          ...(replaceMode ? { value } : {}),
          ...(audience !== editing.audience ? { audience } : {})
        })
        setVersion(updated.version)
      } else {
        await createOrganizationEnvironmentEntry({
          key: key.trim(),
          kind,
          value,
          audience,
          ...(audience === 'selected' && selected.length > 0 ? { agentIds: selected } : {})
        })
      }
      setPendingConfirm(null)
      await onSaved()
    } catch (err) {
      // A variable/agent-secret collision arrives as a 409 and is a BLOCKING error:
      // confirming past it would declassify a write-only key.
      setError(errorMessage(err))
      setPendingConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  /** Commit one binding immediately (edit mode) or stage it (create mode). */
  const toggleBinding = async (agentId: string, next: boolean) => {
    if (!editing) {
      setSelected((current) => (next ? [...current, agentId] : current.filter((id) => id !== agentId)))
      return
    }
    if (bindingBusy) return
    setBindingBusy(agentId)
    setError(null)
    try {
      const updated = next
        ? await assignOrganizationEnvironmentEntry(editing.id, agentId)
        : await unassignOrganizationEnvironmentEntry(editing.id, agentId)
      setSelected(updated.visibleAgentIds)
      setVersion(updated.version)
      onBindingsChanged()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBindingBusy(null)
    }
  }

  return (
    <div className="scrim">
      <div
        className="modal max-w-[560px]"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit entry' : 'Add entry'}
      >
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {editing ? `Edit ${editing.key}` : 'Add variable or secret'}
          </span>
          <button type="button" className="iconbtn" aria-label="Close" disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modalbody flex flex-col gap-[18px]">
          <label className="flex flex-col gap-[6px]">
            <span className={LABEL}>Name</span>
            <input
              className={INPUT}
              placeholder="API_KEY"
              value={key}
              // Immutable after creation: renaming is an explicit delete-and-create,
              // so an edit can never silently change which credential this is.
              disabled={editing !== null}
              onChange={(e) => setKey(e.target.value)}
              aria-label="Name"
              autoFocus={editing === null}
            />
            {editing !== null && (
              <span className={HELP}>The name and type can&apos;t change. Delete and re-create to rename.</span>
            )}
          </label>

          <div className="flex flex-col gap-[6px]">
            <span className={LABEL}>Type</span>
            <div className="grid grid-cols-2 gap-[6px]" role="radiogroup" aria-label="Type">
              {(['variable', 'secret'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={kind === option}
                  disabled={editing !== null}
                  onClick={() => setKind(option)}
                  className={`flex flex-col items-start gap-[1px] rounded-md border px-[11px] py-[8px] text-left ${
                    kind === option
                      ? 'border-(--brand) bg-(--surface-active)'
                      : 'border-(--border-default) bg-(--surface-app)'
                  } ${editing !== null ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                >
                  <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                    {option === 'variable' ? 'Variable' : 'Secret'}
                  </span>
                  <span className="font-sans text-[11px] font-normal leading-[1.4] text-(--text-tertiary)">
                    {option === 'variable' ? 'Plain configuration, readable here' : 'Write-only — never shown again'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-[6px]">
            <span className={LABEL}>{replaceMode && editing ? 'New value' : 'Value'}</span>
            {/* A saved secret needs an EXPLICIT replace action rather than an
                empty-field sentinel. Treating "" as "keep the current value" makes
                the empty string — which the API accepts — impossible to set, so
                intent is tracked separately from the field's content. */}
            {savedSecretKept ? (
              <div className="flex items-center gap-3">
                <span className="mono flex-1 text-[12px] text-(--text-tertiary)">••••••••</span>
                <Button variant="secondary" size="xs" onClick={() => setReplaceMode(true)}>
                  Replace value
                </Button>
              </div>
            ) : (
              <textarea
                className={TEXTAREA}
                placeholder="Value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-label={replaceMode && editing ? 'New value' : 'Value'}
                autoFocus={replaceMode && editing !== null}
              />
            )}
            {replaceMode && editing && secret && (
              <button
                type="button"
                className="lnk self-start text-[11.5px]"
                onClick={() => {
                  setReplaceMode(false)
                  setValue('')
                }}
              >
                Keep the current value instead
              </button>
            )}
          </label>

          <div className="flex flex-col gap-[6px]">
            <span className={LABEL}>Applies to</span>
            <div className="grid grid-cols-2 gap-[6px]" role="radiogroup" aria-label="Applies to">
              {(['all', 'selected'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={audience === option}
                  onClick={() => setAudience(option)}
                  className={`flex cursor-pointer flex-col items-start gap-[1px] rounded-md border px-[11px] py-[8px] text-left ${
                    audience === option
                      ? 'border-(--brand) bg-(--surface-active)'
                      : 'border-(--border-default) bg-(--surface-app)'
                  }`}
                >
                  <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                    {option === 'all' ? 'All agents' : 'Selected agents'}
                  </span>
                  <span className="font-sans text-[11px] font-normal leading-[1.4] text-(--text-tertiary)">
                    {option === 'all'
                      ? 'Every agent you can manage, now and as new ones are configured'
                      : 'Only the agents you pick below'}
                  </span>
                </button>
              ))}
            </div>
            {audience === 'all' && <span className={HELP}>{PICKER_HELP}</span>}
          </div>

          {audience === 'selected' && (
            <div className="flex flex-col gap-[6px]">
              <span className={LABEL}>Agents</span>
              <span className={HELP}>{PICKER_HELP}</span>
              <div className="mt-[4px] max-h-[220px] overflow-y-auto rounded-lg border border-(--border-subtle)">
                {manageableAgents.length === 0 ? (
                  <div className="px-[11px] py-[10px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    You don&apos;t manage any agents yet. You can save this entry now and assign it later.
                  </div>
                ) : (
                  manageableAgents.map((agent) => {
                    const checked = selected.includes(agent.id)
                    return (
                      <label
                        key={agent.id}
                        className="flex cursor-pointer items-center gap-[9px] border-b border-(--border-subtle) px-[11px] py-[8px] last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={bindingBusy !== null}
                          onChange={(e) => void toggleBinding(agent.id, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal leading-normal text-(--text-primary)">
                          {agent.displayName || agent.name}
                        </span>
                      </label>
                    )
                  })
                )}
              </div>
            </div>
          )}

          {(error ?? validation) && (
            <div role="alert" className="font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
              {error ?? validation}
            </div>
          )}
        </div>

        <div className="modalfoot">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || validation !== null}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add'}
          </Button>
        </div>
      </div>

      {pendingConfirm && (
        <ConfirmationDialog
          title={pendingConfirm === 'all' ? 'Apply to all agents?' : `Replace the value of ${editing?.key}?`}
          confirmLabel={pendingConfirm === 'all' ? 'Apply to all' : 'Replace'}
          busy={busy}
          onConfirm={() => void save()}
          onClose={() => (busy ? undefined : setPendingConfirm(null))}
        >
          {pendingConfirm === 'all' ? (
            <>
              This assigns <span className="mono">{key.trim()}</span> to every agent you can manage, and to agents you
              configure later. Agents you cannot manage are not affected, and existing assignments are kept.
            </>
          ) : (
            <>
              Agents assigned <span className="mono">{editing?.key}</span> will receive the new value. The previous
              value cannot be recovered.
            </>
          )}
          <RunningProcessNote />
        </ConfirmationDialog>
      )}
    </div>
  )
}

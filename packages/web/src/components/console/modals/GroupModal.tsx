// No 'use client' here: rendered only by ModalProvider (the client boundary).

import { useState } from 'react'
import type { DaemonRow, MemberSetRow } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { Button, Icon } from '@/components/ui'

/**
 * New / Edit group (docs/designs/daemon-groups.md §2) — name and membership in one dialog.
 *
 * Membership belongs here rather than only on each daemon's own page: a group that cannot be
 * filled where it is created is not a feature, and "which machines are in it" is the only thing
 * about a group worth editing besides its name.
 *
 * Agents pinned to a machine do not block it joining — they come WITH it (§3): the control plane
 * stops each on that machine and re-places it on the group in one step, and the machine claims them
 * back as a member. So the row says what will happen rather than refusing. Leaving is the asymmetric
 * one, refused while the machine still holds live work; that lives on the daemon's own page next to
 * the drain state. Each membership write is applied on its own, so one refusal reports itself and
 * leaves the rest of the edit intact.
 */
export default function GroupModal({ group, onClose }: { group?: MemberSetRow; onClose: () => void }) {
  const { createGroup, renameGroup, enrollInGroup, withdrawFromGroup, daemons, agents } = useConsoleData()
  const [name, setName] = useState(group?.name ?? '')
  // The membership this dialog is editing, seeded from the group and applied on save.
  const [members, setMembers] = useState<string[]>(group?.memberDaemonIds ?? [])
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Set when a machine could not confirm it stopped its agents: the operator may assert it is
  // permanently stopped, which is the move's own force contract and the only safety boundary a
  // machine outside the ledger has (§3).
  const [forceOffer, setForceOffer] = useState(false)
  const trimmed = name.trim()

  // A daemon the org owns is a candidate unless it is in a DIFFERENT group: a daemon is in at most
  // one, and moving it between groups is a two-phase transition, not a checkbox.
  const candidates = daemons.filter((d) => !d.pool && (!d.memberSetId || d.memberSetId === group?.setId))
  const pinnedCount = (daemon: DaemonRow) => agents.filter((a) => a.daemon === daemon.daemonId).length

  const toggle = (daemonId: string) =>
    setMembers((current) =>
      current.includes(daemonId) ? current.filter((id) => id !== daemonId) : [...current, daemonId]
    )

  const save = async (force = false) => {
    if (saving || !trimmed) return
    setSaving(true)
    setErr(null)
    if (force) setForceOffer(false)
    try {
      const setId = group ? group.setId : (await createGroup(trimmed)).setId
      if (group && trimmed !== group.name) await renameGroup(setId, trimmed)
      const before = new Set(group?.memberDaemonIds ?? [])
      const after = new Set(members)
      // Each membership write is its own request with its own precondition, so they are applied one
      // at a time: a refusal names the machine that caused it instead of failing the whole dialog.
      for (const daemonId of members.filter((id) => !before.has(id))) await enrollInGroup(setId, daemonId, { force })
      for (const daemonId of [...before].filter((id) => !after.has(id))) await withdrawFromGroup(setId, daemonId)
      onClose()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setErr(message)
      setForceOffer(/permanently stopped/.test(message))
      setSaving(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="layers" size={15} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">
          {group ? 'Edit group' : 'New group'}
        </span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <div className="fld">
          <span className="fldlbl">Name</span>
          <input
            className="inp focus:border-(--brand) focus:outline-none"
            placeholder="edge-pool"
            value={name}
            maxLength={64}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="fld mt-[14px]">
          <span className="fldlbl">Daemons</span>
          {candidates.length === 0 ? (
            <div className="rounded-lg border border-(--border-subtle) bg-(--surface-sunken) px-3 py-[14px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
              No daemons available. Connect one, or remove it from its current group first.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-(--border-subtle)">
              {candidates.map((daemon) => {
                const checked = members.includes(daemon.daemonId)
                const wasMember = group?.memberDaemonIds.includes(daemon.daemonId) ?? false
                // What joining will DO to this machine's own agents — they move onto the group with
                // it, which is the one consequence worth stating before the click.
                const bringing = checked && !wasMember ? pinnedCount(daemon) : 0
                return (
                  <button
                    key={daemon.daemonId}
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-[10px] border-0 border-b border-(--border-subtle) bg-(--surface-card) px-3 py-[10px] text-left last:border-b-0 hover:bg-(--surface-hover)"
                    onClick={() => toggle(daemon.daemonId)}
                  >
                    <span
                      className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border ${
                        checked ? 'border-(--brand) bg-(--brand)' : 'border-(--border-strong) bg-(--surface-card)'
                      }`}
                    >
                      {checked && <Icon name="check" size={13} color="#fff" />}
                    </span>
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-md bg-(--surface-sunken)">
                      <Icon name="server" size={13} color="var(--text-tertiary)" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mono block truncate text-[12.5px] font-medium text-(--text-primary)">
                        {daemon.name}
                      </span>
                      <span className="block truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                        {bringing > 0
                          ? `Its ${bringing} agent${bringing === 1 ? '' : 's'} move onto the group with it`
                          : daemon.status === 'online'
                            ? 'Online'
                            : 'Offline'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <p className="mt-[12px] font-sans text-[12px] font-normal leading-[1.6] text-(--text-tertiary)">
          An agent placed on this group runs on whichever member is serving, so it keeps running when any single one
          does not.
        </p>
        {err && (
          <div className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
            <Icon name="triangle-alert" size={15} />
            {err}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {forceOffer && (
          <Button
            variant="danger"
            onClick={() => void save(true)}
            className={saving ? 'cursor-default opacity-50' : undefined}
          >
            It is stopped — join anyway
          </Button>
        )}
        <Button onClick={() => void save()} className={!saving && trimmed ? undefined : 'cursor-default opacity-50'}>
          {saving ? 'Saving…' : group ? 'Save' : 'Create group'}
        </Button>
      </div>
    </>
  )
}

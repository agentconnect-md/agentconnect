'use client'

// Skills library card (Tools & Skills page) — one surface for the org-level
// Git source registry (docs/designs/shared-skills.md) and centrally accepted
// immutable managed bundles (docs/designs/organization-knowledge.md). Git
// sources install via `npx skills`; managed bundles use the daemon's pinned
// digest cache. Per-agent enablement for both lives on the agent detail view.
//
// A Git source is registered two ways, both behind the header's "Add" menu (same
// shape as the MCP servers card): "Import from GitHub" takes a repository you
// already know, and "Search skills.sh" searches the public registry by skill
// name (InstallRegistrySkillModal). Both end at the same POST — the second
// just fills the source string and skill filter from the hit you picked.
//
// A source records only WHERE skills come from (source string + optional ref /
// subDir / skill filter) — nothing secret. Self-contained (own create/edit/delete
// dialogs in a scrim, like the MCP servers card).

import { useRef, useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import {
  fmtDate,
  listManagedSkills,
  setManagedSkillArchived,
  type ManagedSkillDto,
  type SkillSourceDto
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { ManagedSkillTile } from '@/components/console/ManagedSkillTile'
import { InstallRegistrySkillModal } from '@/components/console/InstallRegistrySkillModal'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { VisibilityField, VisibilityValue, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { SkillMark, SkillSourceLine, ToolTile, ToolTileGrid } from '@/components/console/ToolTile'
import { GithubMark, LoadingState } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'

/** Split a comma/whitespace-separated skill filter into a clean string[]. */
function parseSkills(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function SkillSourcesCard({ canWrite, canManage }: { canWrite: boolean; canManage: boolean }) {
  const { skillSources, skillSourcesLoading } = useConsoleData()
  const { activeOrg } = useOrgs()
  const { mutate: mutateSWR } = useSWRConfig()
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [editing, setEditing] = useState<SkillSourceDto | null>(null)
  const [deleting, setDeleting] = useState<SkillSourceDto | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [managedActionError, setManagedActionError] = useState<string | null>(null)
  const managedSkillsKey = consoleKeys.managedSkills(activeOrg?.id, includeArchived)
  const activeManagedSkillsKey = consoleKeys.managedSkills(activeOrg?.id, false)
  const managedSkills = useSWR(managedSkillsKey, ([, orgId, , archiveMode]) =>
    listManagedSkills(archiveMode === 'include-archived', orgId)
  )
  const managedRows = managedSkills.data ?? []
  const loading = skillSourcesLoading || managedSkills.isLoading
  const empty = skillSources.length === 0 && managedRows.length === 0
  const archiveManagedSkill = async (skill: ManagedSkillDto) => {
    setManagedActionError(null)
    try {
      await setManagedSkillArchived(skill.id, !skill.archivedAt)
      await Promise.all([
        managedSkills.mutate(),
        ...(includeArchived && activeManagedSkillsKey ? [mutateSWR(activeManagedSkillsKey)] : [])
      ])
    } catch (cause) {
      setManagedActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="card overflow-hidden">
      <div className="cardhead flex-wrap justify-between gap-2">
        <span className="inline-flex items-baseline gap-[10px]">
          <span className="cardtitle">Skills library</span>
          <span className="mono text-[11px] text-(--text-tertiary)">Git sources and managed bundles</span>
        </span>
        <span className="flex flex-wrap items-center justify-end gap-3">
          <label className="flex items-center gap-2 font-sans text-[11.5px] text-(--text-tertiary)">
            Include archived
            <Toggle checked={includeArchived} onChange={setIncludeArchived} />
          </label>
          {canWrite && (
            <AnchoredFlyout
              ariaLabel="Add skill source"
              estimatedHeight={154}
              trigger={({ open, menuId, toggle }) => (
                <Button
                  variant="secondary"
                  size="xs"
                  onClick={toggle}
                  ariaExpanded={open}
                  ariaHasPopup="menu"
                  ariaControls={open ? menuId : undefined}
                >
                  <Icon name="plus" size={14} />
                  Add
                  <Icon name="chevron-down" size={13} color="var(--text-tertiary)" />
                </Button>
              )}
            >
              {({ close }) => (
                <>
                  <button
                    role="menuitem"
                    onClick={() => {
                      close()
                      setBrowsing(true)
                    }}
                    className="flex w-full cursor-pointer items-start gap-[9px] rounded-[6px] border-0 bg-transparent p-[10px] text-left hover:bg-(--surface-hover)"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
                      <Icon name="search" size={16} color="var(--brand)" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                        Search skills.sh
                      </span>
                      <span className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
                        Find a skill in the public registry by name
                      </span>
                    </span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => {
                      close()
                      setCreating(true)
                    }}
                    className="flex w-full cursor-pointer items-start gap-[9px] rounded-[6px] border-0 bg-transparent p-[10px] text-left hover:bg-(--surface-hover)"
                  >
                    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
                      <GithubMark color="var(--brand)" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                        Import from GitHub
                      </span>
                      <span className="mt-[2px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
                        Register a repository you already know
                      </span>
                    </span>
                  </button>
                </>
              )}
            </AnchoredFlyout>
          )}
        </span>
      </div>

      {loading && empty && !managedSkills.error ? (
        <LoadingState size={22} padding={20} />
      ) : empty && !managedSkills.error ? (
        <div className="px-4 py-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No skills yet. Install one from skills.sh, import a GitHub source, or accept a managed skill suggestion to
          make skills available to your agents.
        </div>
      ) : (
        <ToolTileGrid>
          {managedRows.map((skill) => (
            <ManagedSkillTile
              key={skill.id}
              skill={skill}
              canManage={canManage}
              onArchive={() => void archiveManagedSkill(skill)}
            />
          ))}
          {skillSources.map((s) => (
            <SourceTile
              key={s.id}
              s={s}
              canWrite={canWrite}
              onEdit={() => setEditing(s)}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </ToolTileGrid>
      )}

      {(managedSkills.error || managedActionError) && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] text-(--status-error)">
          {managedActionError ?? managedSkills.error.message}
        </div>
      )}

      {browsing && (
        <div className="scrim">
          <div className="modal">
            <InstallRegistrySkillModal existing={skillSources} onClose={() => setBrowsing(false)} />
          </div>
        </div>
      )}
      {creating && (
        <div className="scrim">
          <div className="modal">
            <CreateSkillSourceModal onClose={() => setCreating(false)} />
          </div>
        </div>
      )}
      {editing && (
        <div className="scrim">
          <div className="modal">
            <EditSkillSourceModal source={editing} onClose={() => setEditing(null)} />
          </div>
        </div>
      )}
      {deleting && (
        <div className="scrim">
          <div className="modal">
            <DeleteSkillSourceModal source={deleting} onClose={() => setDeleting(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

function SourceTile({
  s,
  canWrite,
  onEdit,
  onDelete
}: {
  s: SkillSourceDto
  canWrite: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <ToolTile
      mark={<SkillMark />}
      name={s.name}
      badge={
        s.ref ? (
          <span className="badge max-w-[92px] flex-none truncate bg-(--status-info-soft) text-[9.5px] text-(--status-info)">
            {s.ref}
          </span>
        ) : undefined
      }
      subtitle={<SkillSourceLine source={s.source} subDir={s.subDir} />}
      action={
        canWrite ? (
          <>
            <button className="iconbtn h-6 w-6" onClick={onEdit} title="Edit">
              <Icon name="pencil" size={12} />
            </button>
            <button className="iconbtn h-6 w-6" onClick={onDelete} title="Delete">
              <Icon name="trash-2" size={12} />
            </button>
          </>
        ) : undefined
      }
      footer={
        <div className="flex min-w-0 items-center gap-2">
          <VisibilityValue visibility={s.visibility} sharedWith={s.sharedWith} />
          <span className="mono ml-auto min-w-0 truncate text-right text-[10.5px] text-(--text-disabled)">
            added {fmtDate(s.createdAt)}
          </span>
        </div>
      }
    />
  )
}

/** Register a Git skill source. Reused by the agent detail view's Skills card,
 *  which passes `onCreated` to enable the new source on that agent right away. */
export function CreateSkillSourceModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated?: (created: SkillSourceDto) => void
}) {
  const { createSkillSource } = useConsoleData()
  const { me } = useProfile()
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [ref, setRef] = useState('')
  const [subDir, setSubDir] = useState('')
  const [skills, setSkills] = useState('')
  const [sharing, setSharing] = useState<SharingValue>({ visibility: 'org', sharedWith: [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Default the reference name to the repo's last path segment when the user hasn't typed one.
  const derivedName =
    name.trim() ||
    source
      .trim()
      .replace(/\.git$/, '')
      .split('/')
      .filter(Boolean)
      .pop() ||
    ''
  const valid = !!(derivedName && source.trim())

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      const created = await createSkillSource({
        name: derivedName,
        source: source.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(subDir.trim() ? { subDir: subDir.trim() } : {}),
        skills: parseSkills(skills),
        ...(sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {})
      })
      onCreated?.(created)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="book-open" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Import skills from GitHub</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        <div className="flex flex-col gap-[14px]">
          <div className="fld">
            <span className="fldlbl">Source</span>
            <input
              className="inp mn"
              placeholder="owner/repo or https://github.com/owner/repo"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              autoFocus
            />
            <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              A repo of skills (each a folder with a SKILL.md). Passed to `npx skills add` on the daemon.
            </span>
          </div>
          <div className="fld">
            <span className="fldlbl">Name</span>
            <input
              className="inp mn"
              placeholder={derivedName || 'platform-skills'}
              value={name}
              maxLength={64}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-[14px]">
            <div className="fld">
              <span className="fldlbl">Ref (optional)</span>
              <input
                className="inp mn"
                placeholder="v1.2.0 / main / a commit"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            </div>
            <div className="fld">
              <span className="fldlbl">Subdir (optional)</span>
              <input
                className="inp mn"
                placeholder="skills"
                value={subDir}
                onChange={(e) => setSubDir(e.target.value)}
              />
            </div>
          </div>
          <div className="fld">
            <span className="fldlbl">Skills (optional)</span>
            <input
              className="inp mn"
              placeholder="review-pr, safe-deploy — blank installs all"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
          </div>
          <VisibilityField value={sharing} onChange={setSharing} />
        </div>
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          className={valid && !busy ? undefined : 'pointer-events-none opacity-50'}
        >
          <Icon name="book-open" size={14} />
          {busy ? 'Importing…' : 'Import'}
        </Button>
      </div>
    </>
  )
}

function EditSkillSourceModal({ source: s, onClose }: { source: SkillSourceDto; onClose: () => void }) {
  const { updateSkillSource, saveSharing } = useConsoleData()
  const [source, setSource] = useState(s.source)
  const [ref, setRef] = useState(s.ref ?? '')
  const [subDir, setSubDir] = useState(s.subDir ?? '')
  const [skills, setSkills] = useState(s.skills.join(', '))
  const [sharing, setSharing] = useState<SharingValue>({ visibility: s.visibility, sharedWith: s.sharedWith })
  const initialSharing = useRef<SharingValue>({ visibility: s.visibility, sharedWith: s.sharedWith })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const valid = !!source.trim()

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      await updateSkillSource(s.id, {
        source: source.trim(),
        ref: ref.trim() ? ref.trim() : null,
        subDir: subDir.trim() ? subDir.trim() : null,
        skills: parseSkills(skills)
      })
      if (s.canManageSharing && !sameSharing(sharing, initialSharing.current)) {
        await saveSharing('skill', s.id, sharing)
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="book-open" size={16} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Edit {s.name}</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        <div className="flex flex-col gap-[14px]">
          <div className="fld">
            <span className="fldlbl">Source</span>
            <input className="inp mn" value={source} onChange={(e) => setSource(e.target.value)} />
            <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              The name is fixed — agents bind by it. Editing a source re-installs it on every agent that enables it.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-[14px]">
            <div className="fld">
              <span className="fldlbl">Ref</span>
              <input
                className="inp mn"
                placeholder="v1.2.0 / main"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
              />
            </div>
            <div className="fld">
              <span className="fldlbl">Subdir</span>
              <input className="inp mn" value={subDir} onChange={(e) => setSubDir(e.target.value)} />
            </div>
          </div>
          <div className="fld">
            <span className="fldlbl">Skills</span>
            <input
              className="inp mn"
              placeholder="blank installs all"
              value={skills}
              onChange={(e) => setSkills(e.target.value)}
            />
          </div>
          <VisibilityField value={sharing} onChange={setSharing} disabled={!s.canManageSharing} />
        </div>
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          className={valid && !busy ? undefined : 'pointer-events-none opacity-50'}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </>
  )
}

function DeleteSkillSourceModal({ source: s, onClose }: { source: SkillSourceDto; onClose: () => void }) {
  const { deleteSkillSource } = useConsoleData()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await deleteSkillSource(s.id)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">Delete {s.name}?</span>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="modalbody">
        <p className="font-sans text-[13px] font-normal leading-[1.5] text-(--text-secondary)">
          This removes the source from your organization. Agents that still enable it must unselect it first. Skills
          already installed in a workspace stay until that workspace is rebuilt.
        </p>
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>
      <div className="modalfoot">
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => void submit()}
          className={busy ? 'pointer-events-none opacity-50' : undefined}
        >
          {busy ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </>
  )
}

'use client'

// Skills library card (Tools & Skills page) — the org-level shared-skills source
// registry (docs/designs/shared-skills.md). Each source is a repo / git URL the
// daemon installs into an agent's workspace via `npx skills` after clone and
// before the ACP session starts. This card lists the sources as tiles and drives
// create / edit / delete; per-agent enablement lives on the agent detail view.
//
// A source records only WHERE skills come from (source string + optional ref /
// subDir / skill filter) — nothing secret. Self-contained (own create/edit/delete
// dialogs in a scrim, like the MCP servers card).

import { useRef, useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { fmtDate, type SkillSourceDto } from '@/lib/api'
import { VisibilityField, VisibilityValue, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

/** Split a comma/whitespace-separated skill filter into a clean string[]. */
function parseSkills(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function SkillSourcesCard({ canWrite }: { canWrite: boolean }) {
  const { skillSources, skillSourcesLoading } = useConsoleData()
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<SkillSourceDto | null>(null)
  const [deleting, setDeleting] = useState<SkillSourceDto | null>(null)

  return (
    <div className="card">
      <div className="cardhead justify-between">
        <span className="inline-flex items-baseline gap-[10px]">
          <span className="cardtitle">Skills library</span>
          <span className="mono text-[11px] text-(--text-tertiary)">installed per agent via npx skills</span>
        </span>
        {canWrite && (
          <Button variant="secondary" size="xs" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            Import from GitHub
          </Button>
        )}
      </div>

      {skillSourcesLoading && skillSources.length === 0 ? (
        <LoadingState size={22} padding={20} />
      ) : skillSources.length === 0 ? (
        <div className="px-4 py-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          No skill sources yet. Import a repo of skills to make them available to your agents.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 px-4 py-[14px] desktop:grid-cols-[repeat(2,1fr)]">
          {skillSources.map((s) => (
            <SourceTile
              key={s.id}
              s={s}
              canWrite={canWrite}
              onEdit={() => setEditing(s)}
              onDelete={() => setDeleting(s)}
            />
          ))}
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
    <div className="flex gap-[11px] rounded-[9px] border border-(--border-subtle) px-[14px] py-[13px]">
      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
        <Icon name="book-open" size={17} color="var(--brand)" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="mono text-[12.5px] font-semibold text-(--text-primary)">{s.name}</span>
          {s.ref && <span className="badge bg-(--status-info-soft) text-[9.5px] text-(--status-info)">{s.ref}</span>}
        </div>
        <div className="mt-[3px] truncate font-mono text-[12px] font-normal leading-[1.45] text-(--text-tertiary)">
          {s.source}
          {s.subDir ? ` · ${s.subDir}` : ''}
        </div>
        <div className="mt-[6px] flex items-center gap-2 font-mono text-[11px] font-normal leading-normal text-(--text-disabled)">
          <VisibilityValue visibility={s.visibility} sharedWith={s.sharedWith} createdBy={s.createdBy} />
          <span>· {s.skills.length > 0 ? `${s.skills.length} skills` : 'all skills'}</span>
          <span>· added {fmtDate(s.createdAt)}</span>
        </div>
      </div>
      {canWrite && (
        <div className="flex flex-none items-start gap-1">
          <button className="iconbtn" onClick={onEdit} title="Edit">
            <Icon name="pencil" size={14} />
          </button>
          <button className="iconbtn" onClick={onDelete} title="Delete">
            <Icon name="trash" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

function CreateSkillSourceModal({ onClose }: { onClose: () => void }) {
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
      await createSkillSource({
        name: derivedName,
        source: source.trim(),
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(subDir.trim() ? { subDir: subDir.trim() } : {}),
        skills: parseSkills(skills),
        ...(sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {})
      })
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
          <VisibilityField value={sharing} onChange={setSharing} creatorUserId={me?.userId} />
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
          <VisibilityField
            value={sharing}
            onChange={setSharing}
            creatorUserId={s.createdBy}
            disabled={!s.canManageSharing}
          />
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

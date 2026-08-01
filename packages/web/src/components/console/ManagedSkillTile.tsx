'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { listManagedSkillRevisions, type ManagedSkillDto, type ManagedSkillRevisionDto } from '@/lib/api'
import { ToolTile } from '@/components/console/ToolTile'
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function Provenance({ value }: { value: ManagedSkillRevisionDto }) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] text-(--text-disabled)">
      <span>{value.source === 'dream' ? 'Dream proposal' : 'manual publish'}</span>
      <span aria-hidden>·</span>
      <time dateTime={value.createdAt}>{when(value.createdAt)}</time>
      {value.sourceAgentId && (
        <>
          <span aria-hidden>·</span>
          <span title={value.sourceAgentId}>agent {value.sourceAgentId}</span>
        </>
      )}
      {value.sourceDreamId && (
        <>
          <span aria-hidden>·</span>
          <span title={value.sourceDreamId}>dream {value.sourceDreamId}</span>
        </>
      )}
      {value.sourceSessionIds.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <span title={value.sourceSessionIds.join(', ')}>
            {value.sourceSessionIds.length} source session{value.sourceSessionIds.length === 1 ? '' : 's'}
          </span>
        </>
      )}
      {value.reviewedByUserId ? (
        <>
          <span aria-hidden>·</span>
          <span>reviewed by {value.reviewedByUserId}</span>
        </>
      ) : value.createdByUserId ? (
        <>
          <span aria-hidden>·</span>
          <span>published by {value.createdByUserId}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span title={value.digest}>{value.digest.slice(0, 19)}…</span>
    </div>
  )
}

/**
 * One centrally accepted immutable skill, rendered inside the same Skills
 * library grid as Git-backed sources. Revision bodies stay lazy: opening the
 * tile is the first request, and currentRevision is part of the SWR key so an
 * accepted update refreshes an already-open tile in place.
 */
export function ManagedSkillTile({
  skill,
  canManage,
  onArchive
}: {
  skill: ManagedSkillDto
  canManage: boolean
  onArchive: () => void
}) {
  const [open, setOpen] = useState(false)
  const [selectedRevision, setSelectedRevision] = useState(skill.currentRevision)
  useEffect(() => setSelectedRevision(skill.currentRevision), [skill.currentRevision])
  const history = useSWR(open ? ['managed-skill-revisions', skill.id, skill.currentRevision] : null, () =>
    listManagedSkillRevisions(skill.id)
  )
  const selected = history.data?.find((revision) => revision.revision === selectedRevision)
  const historyId = `managed-skill-history-${skill.id}`

  return (
    <ToolTile
      mark={
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="sparkles" size={15} color="var(--brand)" />
        </span>
      }
      name={skill.name}
      badge={
        <span
          className={`badge flex-none text-[9.5px] ${
            skill.archivedAt
              ? 'bg-(--surface-sunken) text-(--text-disabled)'
              : 'bg-(--status-info-soft) text-(--status-info)'
          }`}
        >
          {skill.archivedAt ? 'managed · archived' : `managed · rev ${skill.currentRevision}`}
        </span>
      }
      subtitle={skill.description}
      footer={
        <span className="mono text-[10.5px] text-(--text-disabled)">
          {skill.fileCount} file{skill.fileCount === 1 ? '' : 's'} · {bytes(skill.expandedBytes)} expanded · immutable
          bundle
        </span>
      }
      action={
        <>
          <button
            type="button"
            className="iconbtn h-6 w-6"
            onClick={() => setOpen((value) => !value)}
            aria-label={open ? 'Hide revision history' : 'Show revision history'}
            aria-expanded={open}
            aria-controls={historyId}
            title={open ? 'Hide revision history' : 'Show revision history'}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          </button>
          {canManage && skill.canManage && (
            <button
              type="button"
              className="iconbtn h-6 w-6"
              title={skill.archivedAt ? 'Restore' : 'Archive'}
              onClick={onArchive}
            >
              <Icon name={skill.archivedAt ? 'archive-restore' : 'archive'} size={13} />
            </button>
          )}
        </>
      }
      dimmed={!!skill.archivedAt}
    >
      {open && (
        <div id={historyId} className="border-t border-(--border-subtle) bg-(--surface-sunken) px-[14px] py-3">
          {history.isLoading ? (
            <LoadingState size={18} padding={12} />
          ) : history.error ? (
            <div className="font-sans text-[12px] text-(--status-error)">{history.error.message}</div>
          ) : !selected ? (
            <div className="font-sans text-[12px] text-(--text-tertiary)">Revision history is unavailable.</div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 font-sans text-[11px] text-(--text-tertiary)">
                  Revision
                  <select
                    className="inp h-7 min-w-20 py-0 text-[11px]"
                    aria-label={`Revision for ${skill.name}`}
                    value={selectedRevision}
                    onChange={(event) => setSelectedRevision(Number(event.target.value))}
                  >
                    {history.data?.map((revision) => (
                      <option key={revision.revision} value={revision.revision}>
                        {revision.revision}
                        {revision.revision === skill.currentRevision ? ' (current)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="font-mono text-[10px] text-(--text-disabled)">
                  {selected.fileCount} files · {bytes(selected.expandedBytes)} expanded ·{' '}
                  {bytes(selected.compressedBytes)} archive
                </span>
              </div>
              <Provenance value={selected} />
              <div>
                {(selected.manifest.files ?? []).map((file) => (
                  <div key={file.path} className="flex gap-2 py-[3px] font-mono text-[10.5px] text-(--text-tertiary)">
                    <Icon name="file" size={12} />
                    <span className="min-w-0 flex-1 truncate">{file.path}</span>
                    <span>{bytes(file.bytes)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </ToolTile>
  )
}

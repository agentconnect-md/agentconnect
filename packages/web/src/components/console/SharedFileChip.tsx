'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ApiError, downloadSessionFile } from '@/lib/api'
import { saveBlob, type SharedFile } from '@/lib/shared-file'

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type Refusal = 'fileTooLarge' | 'fileChanged' | 'fileGone' | 'downloadUnsupported' | 'downloadFailed'

function refusalOf(err: unknown): Refusal {
  if (!(err instanceof ApiError)) return 'downloadFailed'
  if (err.code === 'WORKSPACE_FILE_TOO_LARGE') return 'fileTooLarge'
  if (err.code === 'WORKSPACE_FILE_CHANGED') return 'fileChanged'
  if (err.code === 'WORKSPACE_FILE_NOT_FOUND') return 'fileGone'
  if (err.code === 'DAEMON_FEATURE_MISSING' || err.code === 'WORKSPACE_SANDBOX_OUTDATED') return 'downloadUnsupported'
  return 'downloadFailed'
}

/** A file the agent shared, as a chip that downloads its original bytes. */
export function SharedFileChip({
  file,
  agentId,
  sessionId
}: {
  file: SharedFile
  agentId?: string
  sessionId?: string
}) {
  const t = useTranslations('Sessions.detail')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const target = file.path && agentId && sessionId ? { path: file.path, agentId, sessionId } : null

  const download = async (): Promise<void> => {
    if (!target || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const blob = await downloadSessionFile(target.agentId, {
        sessionId: target.sessionId,
        path: target.path,
        sha256: file.sha256
      })
      saveBlob(blob, file.name)
    } catch (err) {
      setRefusal(refusalOf(err))
    } finally {
      setBusy(false)
    }
  }

  const body = (
    <>
      <Icon name={file.mimeType.startsWith('image/') ? 'image' : 'file'} size={14} color="var(--text-tertiary)" />
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="flex-none font-normal text-(--text-tertiary)">{fmtBytes(file.bytes)}</span>
    </>
  )
  const chip =
    'inline-flex min-w-0 max-w-full items-center gap-2 rounded-md border border-(--border-default) bg-(--surface-card) px-[10px] py-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)'

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {target ? (
        <button
          type="button"
          onClick={() => void download()}
          aria-busy={busy}
          title={t('downloadFile', { name: file.name })}
          className={`${chip} cursor-pointer transition-colors hover:border-(--border-strong) hover:bg-(--surface-hover)`}
        >
          {body}
          {busy ? <Spinner size={12} /> : <Icon name="download" size={14} color="var(--text-secondary)" />}
        </button>
      ) : (
        <span className={chip}>{body}</span>
      )}
      {refusal && (
        <div className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">{t(refusal)}</div>
      )}
    </div>
  )
}

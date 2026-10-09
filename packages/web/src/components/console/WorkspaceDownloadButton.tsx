'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { ApiError, downloadSessionFile, transferWorkspaceFile, type WorkspaceFileDto } from '@/lib/api'
import { MAX_WORKSPACE_DOWNLOAD_BYTES, openDownloadUrl, saveBlob, viaTransfer } from '@/lib/shared-file'

// Download one workspace file: binary and large text via a presigned object-store URL, small text via the CP proxy.
export function WorkspaceDownloadButton({
  agentId,
  sessionId,
  repo,
  path,
  file,
  transfer
}: {
  agentId: string
  sessionId?: string
  repo?: string
  path: string
  file: Pick<WorkspaceFileDto, 'size' | 'encoding'>
  transfer: boolean
}) {
  const t = useTranslations('Agents.workspaceFiles')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const name = path.split('/').at(-1) ?? path
  const tooLarge = !viaTransfer(file, transfer) && (file.size ?? 0) > MAX_WORKSPACE_DOWNLOAD_BYTES

  const save = async () => {
    if (busy) return
    setErr(null)
    if (tooLarge) return setErr(t('downloadTooLarge'))
    const scope = { path, ...(sessionId ? { sessionId } : {}), ...(repo ? { repo } : {}) }
    setBusy(true)
    try {
      if (viaTransfer(file, transfer)) openDownloadUrl((await transferWorkspaceFile(agentId, scope)).url)
      else saveBlob(await downloadSessionFile(agentId, scope), name)
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined
      setErr(
        code === 'WORKSPACE_FILE_TOO_LARGE' || code === 'WORKSPACE_TOO_LARGE'
          ? t('downloadTooLarge')
          : t('downloadFailed')
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex flex-none items-center gap-2">
      {err ? (
        <span
          data-workspace-download-error=""
          className="font-sans text-[12px] font-normal leading-normal text-(--status-error)"
        >
          {err}
        </span>
      ) : null}
      <button
        type="button"
        data-workspace-download=""
        className="pill flex items-center gap-1 py-[3px]"
        disabled={busy}
        title={t('download')}
        aria-label={t('download')}
        onClick={() => void save()}
      >
        {busy ? <Spinner size={12} /> : <Icon name="download" size={13} />}
        <span className="max-desktop:hidden">{t('download')}</span>
      </button>
    </span>
  )
}

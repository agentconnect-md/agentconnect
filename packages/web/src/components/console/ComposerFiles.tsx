'use client'

import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileSize } from '@/components/console/FileBrowser'
import { WEBCHAT_FILES_MAX } from '@/lib/shared-file'
import { uploadWebchatFile, type ComposerFile } from '@/lib/webchat-file'

/** Why a non-image file cannot be attached, or null when it can be. */
export function composerFileRefusal(transfer: boolean, staged: number): string | null {
  if (!transfer) return 'Only images can be attached here: file uploads need the deployment’s object store.'
  if (staged >= WEBCHAT_FILES_MAX) return `At most ${WEBCHAT_FILES_MAX} files can be attached to one message.`
  return null
}

/** Start uploading one non-image file into a session's composer; the staged entry tracks it until the send. */
export function stageComposerFile(
  opts: {
    sessionId: string
    agentId: string
    transfer: boolean
    getPgFiles: (id: string) => ComposerFile[]
    setPgFiles: (id: string, update: (files: ComposerFile[]) => ComposerFile[]) => void
    onError: (message: string | null) => void
  },
  file: File
): void {
  const { sessionId, agentId, transfer, getPgFiles, setPgFiles, onError } = opts
  const refusal = composerFileRefusal(transfer, getPgFiles(sessionId).length)
  onError(refusal)
  if (refusal) return
  const key = `${Date.now()}:${Math.random().toString(36).slice(2)}`
  setPgFiles(sessionId, (files) => [...files, { key, name: file.name, size: file.size, status: 'uploading' }])
  // A removed entry stays removed: the settled upload updates only an entry still staged under its key.
  const settle = (patch: Partial<ComposerFile>) =>
    setPgFiles(sessionId, (files) => files.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  uploadWebchatFile(agentId, file).then(
    (attachment) => settle({ status: 'ready', attachment }),
    (error: unknown) =>
      settle({ status: 'failed', error: error instanceof Error ? error.message : 'Couldn’t upload that file.' })
  )
}

/** The staged files as removable chips: name, size, and whether the upload landed. */
export function ComposerFileChips({ files, onRemove }: { files: ComposerFile[]; onRemove: (key: string) => void }) {
  if (!files.length) return null
  return (
    <div className="mx-[15px] mt-3 flex flex-wrap gap-2" data-composer-files="">
      {files.map((file) => (
        <span
          key={file.key}
          data-composer-file={file.status}
          title={file.error ?? file.name}
          className={
            file.status === 'failed'
              ? 'flex max-w-full min-w-0 items-center gap-[6px] rounded-md border border-(--status-error) bg-(--status-error-soft) py-1 pr-1 pl-2 font-sans text-[12px] font-normal leading-normal text-(--text-primary)'
              : 'flex max-w-full min-w-0 items-center gap-[6px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) py-1 pr-1 pl-2 font-sans text-[12px] font-normal leading-normal text-(--text-primary)'
          }
        >
          {file.status === 'uploading' ? (
            <Spinner size={12} />
          ) : (
            <Icon
              name={file.status === 'failed' ? 'triangle-alert' : 'file'}
              size={13}
              color={file.status === 'failed' ? 'var(--status-error)' : 'var(--text-secondary)'}
            />
          )}
          <span className="min-w-0 truncate">{file.name}</span>
          <span className="flex-none text-(--text-tertiary)">{formatFileSize(file.size)}</span>
          <button
            type="button"
            className="iconbtn h-5 w-5 flex-none"
            aria-label={`Remove ${file.name}`}
            title={`Remove ${file.name}`}
            onClick={() => onRemove(file.key)}
          >
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

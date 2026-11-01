'use client'

import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileSize } from '@/components/console/FileBrowser'
import { deploymentFileTransfer, WEBCHAT_FILES_MAX } from '@/lib/shared-file'
import { uploadWebchatFile, type ComposerFile, type MarkedFile } from '@/lib/webchat-file'

/** Why a non-image file cannot be attached, or null when it can be. */
export function composerFileRefusal(transfer: boolean, staged: number, size = 0): string | null {
  if (!transfer) return 'Only images can be attached here: file uploads need the deployment’s object store.'
  if (staged >= WEBCHAT_FILES_MAX) return `At most ${WEBCHAT_FILES_MAX} files can be attached to one message.`
  const maxBytes = deploymentFileTransfer()?.maxBytes
  if (maxBytes !== undefined && size > maxBytes)
    return `That file is over this deployment’s ${formatFileSize(maxBytes)} upload limit.`
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
  const refusal = composerFileRefusal(transfer, getPgFiles(sessionId).length, file.size)
  onError(refusal)
  if (refusal) return
  const key = `${Date.now()}:${Math.random().toString(36).slice(2)}`
  setPgFiles(sessionId, (files) => [...files, { key, name: file.name, size: file.size, status: 'uploading' }])
  // A removed entry stays removed: the settled upload updates only an entry still staged under its key.
  const settle = (patch: Partial<ComposerFile>) =>
    setPgFiles(sessionId, (files) => files.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  uploadWebchatFile(agentId, file, { partBytes: deploymentFileTransfer()?.partBytes }).then(
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

const FILE_KINDS: Array<{ test: RegExp; icon: string; tint: string; ink: string }> = [
  { test: /^image\//, icon: 'file-image', tint: '--status-online-soft', ink: '--status-online-text' },
  { test: /^audio\//, icon: 'file-music', tint: '--status-paused-soft', ink: '--status-paused' },
  { test: /^video\//, icon: 'file-video-camera', tint: '--status-paused-soft', ink: '--status-paused' },
  { test: /\/pdf$/, icon: 'file-text', tint: '--status-error-soft', ink: '--status-error' },
  {
    test: /(zip|gzip|tar|7z|rar|compressed)/,
    icon: 'file-archive',
    tint: '--status-paused-soft',
    ink: '--status-paused'
  },
  {
    test: /(csv|spreadsheet|excel)/,
    icon: 'file-spreadsheet',
    tint: '--status-online-soft',
    ink: '--status-online-text'
  },
  {
    test: /^text\/x-|(json|javascript|typescript|xml|yaml|toml|x-sh|python)/,
    icon: 'file-code',
    tint: '--status-info-soft',
    ink: '--status-info'
  },
  { test: /^text\//, icon: 'file-text', tint: '--status-info-soft', ink: '--status-info' }
]

/** The files a sent message names, as cards above its bubble: a type tile, the name, and its extension. */
export function MessageFileCards({ files }: { files: readonly MarkedFile[] }) {
  return (
    <div className="mb-[3px] flex max-w-full flex-wrap justify-end gap-2" data-message-files="">
      {files.map((file, i) => {
        const kind = FILE_KINDS.find((k) => k.test.test(file.mimeType))
        const dot = file.name.lastIndexOf('.')
        const ext = dot > 0 && file.name.length - dot <= 8 ? file.name.slice(dot + 1) : file.mimeType.split('/')[1]
        return (
          <div
            key={`${i}:${file.name}`}
            title={`${file.name} (${file.mimeType})`}
            className="flex w-[220px] max-w-full min-w-0 items-center gap-[10px] rounded-lg border border-(--border-subtle) bg-(--surface-card) py-2 pr-3 pl-2 shadow-(--shadow-xs)"
          >
            <span
              className="flex h-9 w-9 flex-none items-center justify-center rounded-md"
              style={{
                background: `var(${kind?.tint ?? '--surface-sunken'})`,
                color: `var(${kind?.ink ?? '--text-secondary'})`
              }}
            >
              <Icon name={kind?.icon ?? 'file'} size={18} />
            </span>
            <span className="flex min-w-0 flex-col gap-[2px]">
              <span className="truncate font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                {file.name}
              </span>
              <span className="truncate font-mono text-[11px] font-normal leading-normal uppercase text-(--text-tertiary)">
                {ext}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

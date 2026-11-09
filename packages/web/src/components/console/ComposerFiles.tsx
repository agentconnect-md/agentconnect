'use client'

import { useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Spinner } from '@/components/marks'
import { Icon } from '@/components/ui'
import { formatFileSize } from '@/components/console/FileBrowser'
import type { SessionImage } from '@/lib/data'
import { deploymentFileTransfer, WEBCHAT_FILES_MAX } from '@/lib/shared-file'
import { uploadWebchatFile, type ComposerFile, type MarkedFile } from '@/lib/webchat-file'
import { prepareWebchatImage, WEBCHAT_IMAGE_MAX_BYTES } from '@/lib/webchat-image'
import { Scrim } from './Scrim'

// Why a file cannot be uploaded, or null when it can be.
export function composerFileRefusal(transfer: boolean, staged: number, size = 0): string | null {
  if (!transfer) return 'Only images can be attached here: file uploads need the deployment’s object store.'
  if (staged >= WEBCHAT_FILES_MAX) return `At most ${WEBCHAT_FILES_MAX} files can be attached to one message.`
  const maxBytes = deploymentFileTransfer()?.maxBytes
  if (maxBytes !== undefined && size > maxBytes)
    return `That file is over this deployment’s ${formatFileSize(maxBytes)} upload limit.`
  return null
}

// Stage the whole selection before uploading; each entry owns its preview, error and retry.
export function stageComposerFiles(
  opts: {
    sessionId: string
    agentId: string
    transfer: boolean
    getPgFiles: (id: string) => ComposerFile[]
    setPgFiles: (id: string, update: (files: ComposerFile[]) => ComposerFile[]) => void
    onError: (message: string | null) => void
  },
  selected: readonly File[]
): void {
  const { sessionId, agentId, transfer, getPgFiles, setPgFiles, onError } = opts
  if (!selected.length) return
  const refusal = composerFileRefusal(transfer, getPgFiles(sessionId).length + selected.length - 1)
  onError(refusal)
  if (refusal) return
  const jobs = selected.map((file) => {
    const key = crypto.randomUUID()
    let running = false
    const settle = (patch: Partial<ComposerFile>) =>
      setPgFiles(sessionId, (files) => files.map((f) => (f.key === key ? { ...f, ...patch } : f)))
    const upload = async () => {
      if (running) return
      running = true
      settle({ status: 'uploading', error: undefined })
      try {
        const error = composerFileRefusal(transfer, 0, file.size)
        if (error) throw new Error(error)
        // A file without a browser-readable preview still uploads its original.
        const preview = file.type.startsWith('image/')
          ? await prepareWebchatImage(file, WEBCHAT_IMAGE_MAX_BYTES / WEBCHAT_FILES_MAX).catch(() => undefined)
          : undefined
        settle({ preview })
        const attachment = await uploadWebchatFile(agentId, file, { partBytes: deploymentFileTransfer()?.partBytes })
        settle({ status: 'ready', attachment: { ...attachment, ...(preview ? { preview } : {}) } })
      } catch (error) {
        settle({ status: 'failed', error: error instanceof Error ? error.message : 'Couldn’t upload that file.' })
      } finally {
        running = false
      }
    }
    return {
      entry: { key, name: file.name, size: file.size, status: 'uploading' as const, retry: () => void upload() },
      upload
    }
  })
  setPgFiles(sessionId, (files) => [...files, ...jobs.map((job) => job.entry)])
  // Hash and upload one original at a time to keep browser memory bounded.
  void (async () => {
    for (const job of jobs) await job.upload()
  })()
}

/** Element-scoped file drag-and-drop: spread `handlers` on a `relative` container and render `<FileDropOverlay>` while `over`. */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files')
  // stopPropagation lets a zone nested in another claim the drag while keeping the outer zone's counter balanced.
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current += 1
      setOver(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!carriesFiles(e)) return
      e.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setOver(false)
    },
    onDrop: (e: DragEvent) => {
      depth.current = 0
      setOver(false)
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      e.stopPropagation()
      onFiles(Array.from(e.dataTransfer.files))
    }
  }
  return { over, handlers }
}

/** The dashed drop target and scrim shown over a drop zone while files are dragged across it. */
export function FileDropOverlay({ top = 0 }: { top?: number }) {
  const t = useTranslations('Sessions.detail')
  return (
    <div
      aria-hidden
      data-file-drop=""
      // The measured top keeps the target clear of chrome above the drop zone (STYLE.md rule 8).
      style={top ? { top } : undefined}
      className="pointer-events-none absolute inset-0 z-50 flex bg-(--surface-app)/80 p-3 backdrop-blur-[2px]"
    >
      <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-(--brand) bg-(--brand-soft)/50">
        <Icon name="upload" size={28} color="var(--brand)" />
        <span className="font-sans text-[14px] font-medium leading-normal text-(--text-primary)">
          {t('dropToAttach')}
        </span>
      </div>
    </div>
  )
}

/** One attachment card: an image shows its preview and no name; any other file shows its name and extension. */
export interface AttachmentCard {
  key: string
  name: string
  mimeType?: string
  image?: Pick<SessionImage, 'mimeType' | 'data'>
  status?: ComposerFile['status']
  error?: string
  retry?: () => void
}

const CARD = 'group relative h-[112px] w-[136px] flex-none overflow-hidden rounded-lg border'
const CORNER_BTN =
  'iconbtn absolute top-1 z-10 h-6 w-6 rounded-full bg-(--surface-card) shadow-(--shadow-xs) opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'

/** A file's extension for its card, falling back to the MIME subtype. */
export function fileExtension(name: string, mimeType?: string): string {
  const dot = name.lastIndexOf('.')
  if (dot > 0 && name.length - dot <= 9) return name.slice(dot + 1)
  return mimeType?.split('/')[1]?.split(/[.+;-]/)[0] || 'file'
}

/** Click-to-enlarge view of an attached image; it fades and scales in, and out again before unmounting. */
function ImageLightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  const t = useTranslations('Common.actions')
  const [closing, setClosing] = useState(false)
  const close = (): void => {
    if (closing) return
    setClosing(true)
    setTimeout(onClose, LIGHTBOX_MS) // ponytail: a timer, not transitionend, so reduced motion still closes
  }
  return createPortal(
    <Scrim
      onEscape={close}
      onClick={close}
      className={`transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none ${closing ? 'opacity-0' : ''}`}
    >
      <button
        type="button"
        className="iconbtn absolute top-4 right-4 h-9 w-9 rounded-full bg-(--surface-card) shadow-(--shadow-md)"
        aria-label={t('close')}
        title={t('close')}
        onClick={close}
      >
        <Icon name="x" size={18} />
      </button>
      <img
        src={src}
        alt={name}
        title={name}
        className={`max-h-full max-w-full cursor-zoom-out rounded-md bg-(--surface-card) object-contain shadow-(--shadow-xl) transition-transform duration-200 starting:scale-95 motion-reduce:transition-none ${closing ? 'scale-95' : ''}`}
      />
    </Scrim>,
    document.body
  )
}

const LIGHTBOX_MS = 200

function Card({ card, removeLabel, onRemove }: { card: AttachmentCard; removeLabel?: string; onRemove?: () => void }) {
  const [open, setOpen] = useState(false)
  const failed = card.status === 'failed'
  const src = card.image ? `data:${card.image.mimeType};base64,${card.image.data}` : undefined
  const tone = failed
    ? 'border-(--status-error) bg-(--status-error-soft)'
    : src
      ? 'border-(--border-subtle) bg-(--surface-sunken)'
      : 'border-(--border-subtle) bg-(--surface-card)'
  return (
    <div
      data-attachment={src ? 'image' : 'file'}
      {...(card.status ? { 'data-composer-file': card.status } : {})}
      title={card.error ?? card.name}
      className={`${CARD} ${tone} ${src ? '' : 'flex flex-col justify-between p-3'}`}
    >
      {src ? (
        <button
          type="button"
          className="block h-full w-full cursor-zoom-in border-0 bg-transparent p-0"
          aria-label={card.name}
          onClick={() => setOpen(true)}
        >
          <img src={src} alt={card.name} className={`h-full w-full object-cover ${failed ? 'opacity-60' : ''}`} />
        </button>
      ) : (
        <>
          <span className="line-clamp-3 font-sans text-[13px] font-medium leading-[1.4] break-all text-(--text-primary)">
            {card.name}
          </span>
          <span className="truncate self-start rounded-full border border-(--border-default) px-2 py-px font-mono text-[10.5px] font-medium leading-normal text-(--text-secondary) uppercase">
            {fileExtension(card.name, card.mimeType)}
          </span>
        </>
      )}
      {card.status === 'uploading' || failed ? (
        <span className="absolute bottom-2 right-2 flex h-6 w-6 items-center justify-center rounded-full bg-(--surface-card) shadow-(--shadow-xs)">
          {failed ? <Icon name="triangle-alert" size={13} color="var(--status-error)" /> : <Spinner size={12} />}
        </span>
      ) : null}
      {failed && card.retry ? (
        <button
          type="button"
          className={`${CORNER_BTN} left-1 opacity-100`}
          aria-label={`Retry ${card.name}`}
          title={card.error}
          onClick={card.retry}
        >
          <Icon name="rotate-cw" size={12} />
        </button>
      ) : null}
      {onRemove && removeLabel ? (
        <button
          type="button"
          className={`${CORNER_BTN} right-1`}
          aria-label={removeLabel}
          title={removeLabel}
          onClick={onRemove}
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
      {open && src ? <ImageLightbox src={src} name={card.name} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}

/** Attachments as same-size cards in one row that scrolls sideways — a composer's staged ones and a sent message's alike. */
export function AttachmentCards({
  cards,
  onRemove,
  className = ''
}: {
  cards: readonly AttachmentCard[]
  onRemove?: (key: string) => void
  className?: string
}) {
  const t = useTranslations('Sessions.detail')
  if (!cards.length) return null
  return (
    <div
      className={`flex max-w-full min-w-0 gap-2 overflow-x-auto [scrollbar-width:thin] ${className}`}
      data-attachments=""
    >
      {cards.map((card) => (
        <Card
          key={card.key}
          card={card}
          {...(onRemove
            ? { onRemove: () => onRemove(card.key), removeLabel: t('removeFile', { name: card.name }) }
            : {})}
        />
      ))}
    </div>
  )
}

/** The key a composer's inline image card is removed by. */
export const INLINE_IMAGE_KEY = 'inline-image'

/** A composer's inline image and staged files as cards. */
export function composerCards(files: readonly ComposerFile[], image?: SessionImage): AttachmentCard[] {
  return [
    ...(image ? [{ key: INLINE_IMAGE_KEY, name: image.name, mimeType: image.mimeType, image }] : []),
    ...files.map((f) => ({
      key: f.key,
      name: f.name,
      status: f.status,
      ...(f.attachment?.mimeType ? { mimeType: f.attachment.mimeType } : {}),
      ...(f.preview ? { image: f.preview } : {}),
      ...(f.error ? { error: f.error } : {}),
      ...(f.retry ? { retry: f.retry } : {})
    }))
  ]
}

/** A sent message's images and marker-named files as cards; an uploaded image already shown by its preview is not repeated. */
export function messageCards(
  images: readonly SessionImage[] | undefined,
  files: readonly MarkedFile[] | undefined
): AttachmentCard[] {
  const shown = new Set((images ?? []).map((image) => image.name))
  return [
    ...(images ?? []).map((image, i) => ({ key: `i${i}:${image.name}`, name: image.name, image })),
    ...(files ?? [])
      .filter((file) => !(file.mimeType.startsWith('image/') && shown.has(file.name)))
      .map((file, i) => ({ key: `f${i}:${file.name}`, name: file.name, mimeType: file.mimeType }))
  ]
}

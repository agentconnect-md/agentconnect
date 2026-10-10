'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { Scrim } from './Scrim'
import { openDownloadUrl, saveBlob, type SharedFile } from '@/lib/shared-file'
import {
  base64Bytes,
  fetchOriginal,
  originalDownload,
  originalName,
  originalReachable,
  originalStatusKey,
  publishedImageState,
  OriginalError,
  subscribeImageStates,
  type OriginalRefusal,
  type OriginalSource,
  type SharedImageState
} from '@/lib/shared-image'

/** A local object URL for bytes, revoked when the bytes change or the holder unmounts. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  // Created and revoked in one effect, so StrictMode's remount never reuses a revoked URL.
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    const next = URL.createObjectURL(blob)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [blob])
  return url
}

/** The newest state for a post: its own descriptor, or a newer update another surface received. */
function useImageState(postId: string | undefined, base: SharedImageState): SharedImageState {
  const published = useSyncExternalStore(
    subscribeImageStates,
    () => publishedImageState(postId),
    () => undefined
  )
  return useMemo(
    () => (published && published.revision >= base.revision ? { attachment: base.attachment, ...published } : base),
    [published, base]
  )
}

const REFUSAL_KEY = {
  expired: 'originalExpired',
  unavailable: 'originalUnavailable',
  uploading: 'originalUploading',
  uploadFailed: 'originalUploadFailed',
  changed: 'fileChanged',
  tooLarge: 'fileTooLarge',
  gone: 'fileGone',
  unsupported: 'downloadUnsupported',
  failed: 'originalFailed'
} as const satisfies Record<OriginalRefusal, string>

function refusalOf(err: unknown): OriginalRefusal {
  return err instanceof OriginalError ? err.refusal : 'failed'
}

const ACTION =
  'inline-flex items-center gap-[6px] rounded-md border border-(--border-default) bg-(--surface-card) px-[10px] py-[5px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) transition-colors hover:border-(--border-strong) hover:bg-(--surface-hover) disabled:cursor-default disabled:opacity-55'

/** A shared image: its retained preview, caption and original actions — the same card live and in history. */
export function SharedImageCard({
  postId,
  image,
  caption,
  file,
  agentId,
  sessionId
}: {
  postId?: string
  image: SharedImageState
  caption?: string
  file?: SharedFile
  agentId?: string
  sessionId?: string
}) {
  const t = useTranslations('Sessions.detail')
  const state = useImageState(postId, image)
  const preview = useMemo(
    () => new Blob([base64Bytes(state.attachment.data)], { type: state.attachment.mimeType }),
    [state.attachment.data, state.attachment.mimeType]
  )
  const previewUrl = useObjectUrl(preview)
  const [viewing, setViewing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [refusal, setRefusal] = useState<OriginalRefusal | null>(null)
  const source: OriginalSource = {
    ...(postId ? { postId } : {}),
    state,
    ...(file ? { file } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {})
  }
  const reachable = originalReachable(source)
  const status = originalStatusKey(state.original)
  const name = originalName(source)
  const alt = caption || name

  const download = async (): Promise<void> => {
    if (downloading) return
    setDownloading(true)
    setRefusal(null)
    try {
      // A cached original downloads straight from its signed GET, which already answers as an attachment.
      if (state.original.kind === 'cache' && state.original.status === 'ready') {
        openDownloadUrl((await originalDownload(source)).url)
      } else {
        saveBlob(await fetchOriginal(source), name)
      }
    } catch (err) {
      setRefusal(refusalOf(err))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-2" data-testid="shared-image-card">
      {previewUrl && (
        <button
          type="button"
          onClick={() => reachable && setViewing(true)}
          className={`block max-w-full border-0 bg-transparent p-0 ${reachable ? 'cursor-zoom-in' : 'cursor-default'}`}
          aria-label={reachable ? t('viewOriginal') : alt}
        >
          {/* An SVG preview is only ever an image resource: its scripts and links never run here. */}
          <img
            src={previewUrl}
            alt={alt}
            {...(state.attachment.width ? { width: state.attachment.width } : {})}
            {...(state.attachment.height ? { height: state.attachment.height } : {})}
            className="block h-auto max-h-[360px] w-auto max-w-full rounded-md border border-(--border-subtle) object-contain max-desktop:max-h-[280px]"
          />
        </button>
      )}
      {caption && <div className="whitespace-pre-wrap">{caption}</div>}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button type="button" className={ACTION} disabled={!reachable} onClick={() => setViewing(true)}>
          <Icon name="maximize-2" size={13} color="var(--text-secondary)" />
          {t('viewOriginal')}
        </button>
        <button
          type="button"
          className={ACTION}
          disabled={!reachable || downloading}
          aria-busy={downloading}
          onClick={() => void download()}
          title={t('downloadFile', { name })}
        >
          {downloading ? <Spinner size={12} /> : <Icon name="download" size={13} color="var(--text-secondary)" />}
          {t('downloadOriginal')}
        </button>
        {status && (
          <span className="inline-flex items-center gap-[6px] font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
            {status === 'originalUploading' && <Spinner size={11} />}
            {t(status)}
          </span>
        )}
      </div>
      {refusal && (
        <div className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">
          {t(REFUSAL_KEY[refusal])}
        </div>
      )}
      {viewing && <OriginalViewer source={source} name={name} alt={alt} onClose={() => setViewing(false)} />}
    </div>
  )
}

/** Full-resolution viewer: loads the original on open, fits it to the screen, and zooms on request. */
function OriginalViewer({
  source,
  name,
  alt,
  onClose
}: {
  source: OriginalSource
  name: string
  alt: string
  onClose: () => void
}) {
  const t = useTranslations('Sessions.detail')
  const [blob, setBlob] = useState<Blob | null>(null)
  const [refusal, setRefusal] = useState<OriginalRefusal | null>(null)
  const [fit, setFit] = useState(true)
  const [zoom, setZoom] = useState(1)
  const url = useObjectUrl(blob)
  const stateKey = `${source.state.revision}:${source.state.original.kind}`

  useEffect(() => {
    let live = true
    setRefusal(null)
    fetchOriginal(source)
      .then((b) => live && setBlob(b))
      .catch((err) => live && setRefusal(refusalOf(err)))
    return () => {
      live = false
    }
    // Reload only when the original itself changes, not on every parent render.
  }, [stateKey])

  const zoomBy = (factor: number): void => {
    setFit(false)
    setZoom((z) => Math.min(8, Math.max(0.1, z * factor)))
  }
  const button =
    'iconbtn inline-flex h-8 w-8 items-center justify-center rounded-md border border-(--border-default) bg-(--surface-card)'

  return createPortal(
    <Scrim onEscape={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal
        aria-label={name}
        className="flex h-full max-h-[92vh] w-full max-w-[1200px] flex-col overflow-hidden rounded-lg border border-(--border-default) bg-(--surface-card) shadow-(--shadow-xl) max-desktop:max-h-none max-desktop:rounded-none max-desktop:border-0"
      >
        <div className="flex min-w-0 items-center gap-2 border-b border-(--border-subtle) px-4 py-3">
          <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
            {name}
          </span>
          <button
            type="button"
            className={button}
            onClick={() => zoomBy(0.8)}
            title={t('zoomOut')}
            aria-label={t('zoomOut')}
          >
            <Icon name="zoom-out" size={15} />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => zoomBy(1.25)}
            title={t('zoomIn')}
            aria-label={t('zoomIn')}
          >
            <Icon name="zoom-in" size={15} />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => {
              setFit((f) => !f)
              setZoom(1)
            }}
            title={fit ? t('actualSize') : t('fitToScreen')}
            aria-label={fit ? t('actualSize') : t('fitToScreen')}
          >
            <Icon name={fit ? 'scan' : 'shrink'} size={15} />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => blob && saveBlob(blob, name)}
            disabled={!blob}
            title={t('downloadOriginal')}
            aria-label={t('downloadOriginal')}
          >
            <Icon name="download" size={15} />
          </button>
          <button
            type="button"
            className={button}
            onClick={onClose}
            title={t('closeViewer')}
            aria-label={t('closeViewer')}
          >
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-(--surface-sunken) p-4">
          {url ? (
            <img
              src={url}
              alt={alt}
              className={fit ? 'max-h-full max-w-full object-contain' : 'max-w-none'}
              // Zoom is data-driven, so it rides an inline style (STYLE.md rule 8).
              style={fit ? undefined : { transform: `scale(${zoom})`, transformOrigin: 'top left' }}
            />
          ) : refusal ? (
            <div className="font-sans text-[13px] font-medium leading-normal text-(--red-600)">
              {t(REFUSAL_KEY[refusal])}
            </div>
          ) : (
            <div className="flex items-center gap-2 font-sans text-[13px] leading-normal text-(--text-tertiary)">
              <Spinner size={14} />
              {t('originalLoading')}
            </div>
          )}
        </div>
      </div>
    </Scrim>,
    document.body
  )
}

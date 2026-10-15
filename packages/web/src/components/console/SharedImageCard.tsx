'use client'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react'
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

type Size = { w: number; h: number }
type Offset = { x: number; y: number }

const STAGE_PADDING = 16

/** Keeps a panned image from leaving the stage: an axis that fits stays centered. */
function clampOffset(o: Offset, image: Size | null, stage: Size, scale: number): Offset {
  if (!image) return { x: 0, y: 0 }
  const maxX = Math.max(0, (image.w * scale - stage.w) / 2 + STAGE_PADDING)
  const maxY = Math.max(0, (image.h * scale - stage.h) / 2 + STAGE_PADDING)
  return { x: Math.min(maxX, Math.max(-maxX, o.x)), y: Math.min(maxY, Math.max(-maxY, o.y)) }
}

type View = { fit: boolean; zoom: number; offset: Offset }

const FIT_VIEW: View = { fit: true, zoom: 1, offset: { x: 0, y: 0 } }

/** The scale that fits the whole image inside the padded stage, never above actual size. */
function fitScaleOf(image: Size | null, stage: Size): number {
  if (!image) return 1
  return Math.min(
    1,
    Math.max(0, stage.w - STAGE_PADDING * 2) / image.w,
    Math.max(0, stage.h - STAGE_PADDING * 2) / image.h
  )
}

/** Zooms by a factor about a stage point (relative to its center), keeping that point under the cursor. */
function zoomAt(view: View, factor: number, at: Offset, image: Size | null, stage: Size): View {
  const scale = view.fit ? fitScaleOf(image, stage) : view.zoom
  const from = clampOffset(view.offset, image, stage, scale)
  const next = Math.min(8, Math.max(0.1, scale * factor))
  const r = next / scale
  const offset = { x: at.x - (at.x - from.x) * r, y: at.y - (at.y - from.y) * r }
  return { fit: false, zoom: next, offset: clampOffset(offset, image, stage, next) }
}

/** Moves the image by a delta, clamped to the stage. */
function panBy(view: View, dx: number, dy: number, image: Size | null, stage: Size): View {
  const scale = view.fit ? fitScaleOf(image, stage) : view.zoom
  const from = clampOffset(view.offset, image, stage, scale)
  return { ...view, offset: clampOffset({ x: from.x + dx, y: from.y + dy }, image, stage, scale) }
}

/** Full-resolution viewer: loads the original on open, fits it to the screen, zooms by button or pinch, and pans by drag or scroll. */
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
  const [view, setView] = useState<View>(FIT_VIEW)
  const [natural, setNatural] = useState<Size | null>(null)
  const [stage, setStage] = useState<Size>({ w: 0, h: 0 })
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
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

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Trackpad pinch arrives as ctrl+wheel (Chromium, Firefox) or gesture events (Safari); two-finger scroll pans.
  useEffect(() => {
    const el = stageRef.current
    if (!el || !natural) return
    const pointOf = (clientX: number, clientY: number): Offset => {
      const r = el.getBoundingClientRect()
      return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      if (e.ctrlKey) {
        const at = pointOf(e.clientX, e.clientY)
        setView((v) => zoomAt(v, Math.exp(-e.deltaY * unit * 0.01), at, natural, stage))
      } else {
        setView((v) => panBy(v, -e.deltaX * unit, -e.deltaY * unit, natural, stage))
      }
    }
    let gestureScale = 1
    const onGestureStart = (e: Event): void => {
      e.preventDefault()
      gestureScale = 1
    }
    const onGestureChange = (e: Event): void => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      const factor = g.scale / gestureScale
      gestureScale = g.scale
      const at = pointOf(g.clientX, g.clientY)
      setView((v) => zoomAt(v, factor, at, natural, stage))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', onGestureStart)
    el.addEventListener('gesturechange', onGestureChange)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', onGestureStart)
      el.removeEventListener('gesturechange', onGestureChange)
    }
  }, [natural, stage])

  const fit = view.fit
  const scale = fit ? fitScaleOf(natural, stage) : view.zoom
  const shown = clampOffset(view.offset, natural, stage, scale)
  const pannable = !!natural && (natural.w * scale > stage.w || natural.h * scale > stage.h)

  const zoomBy = (factor: number): void => setView((v) => zoomAt(v, factor, { x: 0, y: 0 }, natural, stage))

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!pannable || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    drag.current = { x: e.clientX, y: e.clientY }
    setView((v) => panBy(v, dx, dy, natural, stage))
  }
  const endDrag = (): void => {
    drag.current = null
    setDragging(false)
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
            onClick={() => setView(fit ? { ...FIT_VIEW, fit: false } : FIT_VIEW)}
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
        <div
          ref={stageRef}
          className={`relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden bg-(--surface-sunken) ${pannable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {url ? (
            <img
              src={url}
              alt={alt}
              draggable={false}
              onLoad={(e) =>
                setNatural({ w: e.currentTarget.naturalWidth || 300, h: e.currentTarget.naturalHeight || 150 })
              }
              className={`absolute top-1/2 left-1/2 max-w-none ${natural ? '' : 'invisible'}`}
              // Zoom and pan are data-driven, so they ride an inline style (STYLE.md rule 8).
              style={{
                transform: `translate(-50%, -50%) translate(${shown.x}px, ${shown.y}px) scale(${scale})`
              }}
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

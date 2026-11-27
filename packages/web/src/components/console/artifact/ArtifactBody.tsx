'use client'

// A revision's entry by media type (artifacts.md §5.5, §9): HTML on the content domain, the rest from bytes; nothing renders on the store's origin.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { formatFileSize } from '@/components/console/FileBrowser'
import { escapeHtml, highlight, linkifyHtml, loadHljs } from '@/lib/highlight'
import { fetchArtifactFile, memberFileUrl, type ArtifactFileUrl } from '@/lib/artifact-download'
import { ArtifactSite, SrcdocPage } from './ArtifactSite'
import {
  artifactFileName,
  artifactKind,
  markdownImageRefs,
  resolveArtifactRef,
  type ArtifactManifestFile,
  type ArtifactRevisionDto
} from '@/lib/artifact'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), { ssr: false })

/** Text past this size shows plain, since highlighting it would stall the tab. */
const HIGHLIGHT_MAX_BYTES = 512 * 1024
/** A transparent pixel held by a Markdown image until its file's bytes arrive. */
const PENDING_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='

type Loaded = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; blob: Blob }

/** A URL an `<img>` or `<object>` can load: SVG as a `data:` URL, whose opaque origin keeps it inert even opened in its own tab. */
async function displayUrl(blob: Blob): Promise<string> {
  if (blob.type !== 'image/svg+xml') return URL.createObjectURL(blob)
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('svg read failed'))
    reader.readAsDataURL(blob)
  })
}

function revoke(url: string): void {
  if (url.startsWith('blob:')) URL.revokeObjectURL(url)
}

/** The revision fields a body reads; a share link's revision carries no more than these. */
export type ArtifactBodyRevision = Pick<ArtifactRevisionDto, 'number' | 'manifest'>

/** The entry file's bytes, fetched again whenever the revision changes. */
function useEntryBlob(fileUrl: ArtifactFileUrl, file: ArtifactManifestFile | undefined): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const path = file?.path
  const mediaType = file?.mediaType
  useEffect(() => {
    if (!path || !mediaType) {
      setLoaded({ status: 'failed' })
      return
    }
    const controller = new AbortController()
    setLoaded({ status: 'loading' })
    fetchArtifactFile(fileUrl, { path, mediaType }, controller.signal).then(
      (blob) => setLoaded({ status: 'ready', blob }),
      () => {
        if (!controller.signal.aborted) setLoaded({ status: 'failed' })
      }
    )
    return () => controller.abort()
  }, [fileUrl, path, mediaType])
  return loaded
}

/** A URL for a loaded blob, revoked when the blob changes or the view goes. */
function useDisplayUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) {
      setUrl(null)
      return
    }
    let made: string | null = null
    let live = true
    void displayUrl(blob).then((next) => {
      made = next
      if (live) setUrl(next)
      else revoke(next)
    })
    return () => {
      live = false
      if (made) revoke(made)
      setUrl(null)
    }
  }, [blob])
  return url
}

function useBlobText(blob: Blob | undefined): string | null {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    setText(null)
    if (!blob) return
    let live = true
    void blob.text().then((value) => live && setText(value))
    return () => {
      live = false
    }
  }, [blob])
  return text
}

export function ArtifactBodyNotice({
  icon,
  tone,
  children
}: {
  icon: string
  tone: 'muted' | 'error'
  children: ReactNode
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)"
    >
      <Icon name={icon} size={22} color={tone === 'error' ? 'var(--amber-500)' : 'var(--text-tertiary)'} />
      {children}
    </div>
  )
}

/** The entry of one revision, rendered by its manifest media type. */
export function ArtifactBody({
  artifactId,
  revision,
  title,
  download,
  contentDomain,
  path,
  onPath,
  fileUrl
}: {
  artifactId: string
  revision: ArtifactBodyRevision
  title: string
  /** The Download action offered where nothing renders in the console. */
  download: ReactNode
  /** Where HTML runs; without one a page falls back to `srcdoc`. */
  contentDomain?: string
  /** The site page to open first, from the viewer's URL. */
  path?: string | null
  /** The site page shown, for the viewer's URL. */
  onPath?: (path: string | null) => void
  /** Where the files are read; a member's organization routes when absent, a share link's on the share page. */
  fileUrl?: ArtifactFileUrl
}) {
  const t = useTranslations('Artifacts.viewer')
  const number = revision.number
  const files = useMemo(() => fileUrl ?? memberFileUrl(artifactId, number), [fileUrl, artifactId, number])
  const entry = revision.manifest.files.find((file) => file.path === revision.manifest.entry)
  const kind = entry ? artifactKind(entry.mediaType, entry.path) : 'other'
  const site = kind === 'page' && contentDomain !== undefined
  const loaded = useEntryBlob(files, kind === 'other' || site ? undefined : entry)

  if (kind === 'other' || !entry)
    return (
      <ArtifactBodyNotice icon="file" tone="muted">
        <span className="font-medium text-(--text-primary)">{artifactFileName(revision.manifest.entry)}</span>
        <span className="text-(--text-tertiary)">
          {entry ? formatFileSize(entry.bytes) : ''} · {t('noPreview')}
        </span>
        {download}
      </ArtifactBodyNotice>
    )
  if (site)
    return (
      <ArtifactSite
        key={`${artifactId}:${revision.number}`}
        artifactId={artifactId}
        revision={revision}
        title={title}
        domain={contentDomain}
        path={path ?? null}
        onPath={onPath}
        download={download}
        fileUrl={files}
      />
    )
  if (loaded.status === 'loading')
    return (
      <div className="flex flex-1 items-center justify-center py-12" aria-busy="true">
        <Spinner size={30} />
      </div>
    )
  if (loaded.status === 'failed')
    return (
      <ArtifactBodyNotice icon="triangle-exclamation-point" tone="error">
        {t('loadFailed')}
      </ArtifactBodyNotice>
    )
  if (kind === 'page') return <ArtifactPage blob={loaded.blob} title={title} />
  if (kind === 'image') return <ArtifactImage blob={loaded.blob} title={title} />
  if (kind === 'pdf') return <ArtifactPdf blob={loaded.blob} title={title} download={download} />
  if (kind === 'document')
    return <ArtifactMarkdown fileUrl={files} entry={entry.path} files={revision.manifest.files} blob={loaded.blob} />
  return <ArtifactSource blob={loaded.blob} name={entry.path} />
}

/** A page as `srcdoc`, where no content domain is configured. */
function ArtifactPage({ blob, title }: { blob: Blob; title: string }) {
  const html = useBlobText(blob)
  return html === null ? null : <SrcdocPage html={html} title={title} />
}

function ArtifactImage({ blob, title }: { blob: Blob; title: string }) {
  const url = useDisplayUrl(blob)
  if (!url) return null
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img src={url} alt={title} className="max-h-full max-w-full object-contain" />
    </div>
  )
}

/** The browser's own PDF viewer; a browser that embeds none (some phones) gets the download instead. */
function ArtifactPdf({ blob, title, download }: { blob: Blob; title: string; download: ReactNode }) {
  const url = useDisplayUrl(blob)
  const t = useTranslations('Artifacts.viewer')
  if (!url) return null
  return (
    <object data={url} type="application/pdf" aria-label={title} className="block min-h-0 w-full flex-1">
      <ArtifactBodyNotice icon="book-open" tone="muted">
        {t('pdfUnsupported')}
        {download}
      </ArtifactBodyNotice>
    </object>
  )
}

function ArtifactSource({ blob, name }: { blob: Blob; name: string }) {
  const content = useBlobText(blob)
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    setHtml(null)
    if (content === null || blob.size > HIGHLIGHT_MAX_BYTES) return
    let live = true
    loadHljs().then(
      (hljs) => live && setHtml(highlight(hljs, content, name)),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [content, name, blob.size])
  const codeHtml = useMemo(() => (content === null ? null : linkifyHtml(html ?? escapeHtml(content))), [content, html])
  if (codeHtml === null) return null
  return (
    <pre className="hljs mono m-0 min-h-0 flex-1 overflow-auto [word-break:break-word] bg-transparent px-4 py-[14px] text-[12px] leading-[1.7] whitespace-pre-wrap text-(--text-primary)">
      <code dangerouslySetInnerHTML={{ __html: codeHtml }} />
    </pre>
  )
}

/** Markdown with its local image references swapped for URLs of the revision's own files (artifacts.md §9). */
export function ArtifactMarkdown({
  fileUrl,
  entry,
  files,
  blob
}: {
  fileUrl: ArtifactFileUrl
  entry: string
  files: ArtifactManifestFile[]
  blob: Blob
}) {
  const content = useBlobText(blob)
  const images = useMemo(
    () => new Map(files.filter((file) => file.mediaType.startsWith('image/')).map((file) => [file.path, file])),
    [files]
  )
  const [urls, setUrls] = useState<ReadonlyMap<string, string>>(new Map())
  // Only the image files the text names are fetched; the renderer then maps each source it meets.
  const wanted = useMemo(() => {
    if (content === null) return []
    const paths = markdownImageRefs(content).flatMap((ref) => resolveArtifactRef(entry, ref) ?? [])
    return [...new Set(paths)].filter((path) => images.has(path))
  }, [content, entry, images])
  useEffect(() => {
    const made: string[] = []
    let live = true
    setUrls(new Map())
    for (const path of wanted)
      void fetchArtifactFile(fileUrl, images.get(path)!)
        .then(displayUrl)
        .then(
          (url) => {
            if (!live) return revoke(url)
            made.push(url)
            setUrls((prev) => new Map(prev).set(path, url))
          },
          () => undefined
        )
    return () => {
      live = false
      made.forEach(revoke)
    }
  }, [fileUrl, wanted, images])

  const resolveImage = (src: string): string | undefined => {
    const path = resolveArtifactRef(entry, src)
    if (!path || !images.has(path)) return undefined
    return urls.get(path) ?? PENDING_IMAGE
  }

  if (content === null) return null
  return (
    <div className="min-h-0 flex-1 overflow-auto px-[18px] py-4 desktop:px-8 desktop:py-6">
      <MarkdownView content={content} resolveImage={resolveImage} />
    </div>
  )
}

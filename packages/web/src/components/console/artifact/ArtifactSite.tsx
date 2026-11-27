'use client'

// An HTML entry on its revision's own content-domain origin (artifacts.md §5.5), or as `srcdoc` where the browser cannot route a site.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ARTIFACT_FRAME_SANDBOX } from '@/lib/mcp-app-frame'
import { fetchArtifactFile } from '@/lib/artifact-download'
import { artifactContentOrigin, SHIM_PATH } from '@/lib/artifact-content/protocol'
import { createPortServer, entryPagePath, servedPath } from '@/lib/artifact-content/port-server'
import { createPathSync, readShimMessage, readViewerPath, SHIM_READY_MS } from '@/lib/artifact-content/viewer-path'
import type { ArtifactRevisionDto } from '@/lib/artifact'

/** The content-domain frame's sandbox: same-origin so the shim can register its worker; no top navigation, popups or forms. */
export const ARTIFACT_SITE_SANDBOX = 'allow-scripts allow-same-origin'

/** A page in a sandboxed `srcdoc` frame: opaque origin, no forms, popups or top navigation (artifacts.md §5.5). */
export function SrcdocPage({ html, title }: { html: string; title: string }) {
  return (
    <iframe
      title={title}
      sandbox={ARTIFACT_FRAME_SANDBOX}
      srcDoc={html}
      referrerPolicy="no-referrer"
      className="block min-h-0 w-full flex-1 border-0 bg-white"
    />
  )
}

/** One revision's site; mount it keyed by revision, since `path` is read once, as the page to open first. */
export function ArtifactSite({
  artifactId,
  revision,
  title,
  domain,
  path,
  onPath,
  download
}: {
  artifactId: string
  revision: ArtifactRevisionDto
  title: string
  domain: string
  /** The page to open, from the viewer's URL; the entry when absent. */
  path?: string | null
  /** The page the frame shows, coalesced; null when it is the entry. */
  onPath?: (path: string | null) => void
  download: ReactNode
}) {
  const t = useTranslations('Artifacts.viewer')
  const number = revision.number
  const { entry, files } = revision.manifest
  const origin = artifactContentOrigin(artifactId, number, domain)
  const entryPath = entryPagePath(entry)
  // The entry's own file path names the same page, so either one drops the viewer's path param.
  const entryFile = servedPath(entry)
  const server = useMemo(
    () =>
      createPortServer({
        files,
        entry,
        load: async (file) => (await fetchArtifactFile(artifactId, number, file)).arrayBuffer()
      }),
    [artifactId, number, entry, files]
  )
  useEffect(() => () => server.close(), [server])

  const frame = useRef<HTMLIFrameElement | null>(null)
  const [ready, setReady] = useState(false)
  const [fallback, setFallback] = useState(false)
  const [opened] = useState(() => readViewerPath(path) ?? entryPath)
  const onPathRef = useRef(onPath)
  useEffect(() => {
    onPathRef.current = onPath
  })

  useEffect(() => {
    if (fallback) return
    let current = opened
    const sync = createPathSync(
      (next) => onPathRef.current?.(next),
      opened === entryPath || opened === entryFile ? null : opened
    )
    const timer = window.setTimeout(() => setFallback(true), SHIM_READY_MS)
    const send = (message: { t: 'port'; entry?: string }) =>
      frame.current?.contentWindow?.postMessage(message, origin, [server.port()])
    const listener = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== origin) return
      const message = readShimMessage(event.data)
      if (!message) return
      if (message.t === 'ready') {
        window.clearTimeout(timer)
        setReady(true)
        send({ t: 'port', entry: current })
      } else if (message.t === 'need-port') send({ t: 'port' })
      else if (message.t === 'unsupported') setFallback(true)
      else {
        const next = readViewerPath(message.path)
        if (next === null) return
        current = next
        sync.push(next === entryPath || next === entryFile ? null : next)
      }
    }
    window.addEventListener('message', listener)
    return () => {
      window.removeEventListener('message', listener)
      window.clearTimeout(timer)
      sync.cancel()
    }
  }, [fallback, origin, server, opened, entryPath, entryFile])

  if (fallback)
    return <SiteFallback server={server} entry={entry} title={title} download={download} notice={t('siteFallback')} />
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        ref={frame}
        title={title}
        sandbox={ARTIFACT_SITE_SANDBOX}
        src={`${origin}${SHIM_PATH}`}
        referrerPolicy="no-referrer"
        className="block min-h-0 w-full flex-1 border-0 bg-white"
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-(--surface-card)" aria-busy="true">
          <Spinner size={30} />
        </div>
      )}
    </div>
  )
}

/** The entry alone as `srcdoc`, read through the revision's cache, with the notice that the rest of the site cannot load. */
function SiteFallback({
  server,
  entry,
  title,
  download,
  notice
}: {
  server: ReturnType<typeof createPortServer>
  entry: string
  title: string
  download: ReactNode
  notice: string
}) {
  const t = useTranslations('Artifacts.viewer')
  const [html, setHtml] = useState<string | null | 'failed'>(null)
  useEffect(() => {
    let live = true
    server.file(entry).then(
      (bytes) => live && setHtml(new TextDecoder().decode(bytes)),
      () => live && setHtml('failed')
    )
    return () => {
      live = false
    }
  }, [server, entry])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="status"
        data-testid="artifact-site-fallback"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)"
      >
        <span className="inline-flex min-w-0 flex-1 items-center gap-2">
          <Icon name="info" size={14} color="var(--text-tertiary)" />
          {notice}
        </span>
        {download}
      </div>
      {html === 'failed' ? (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center px-6 py-12 text-center font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)"
        >
          {t('loadFailed')}
        </div>
      ) : html === null ? (
        <div className="flex flex-1 items-center justify-center py-12" aria-busy="true">
          <Spinner size={30} />
        </div>
      ) : (
        <SrcdocPage html={html} title={title} />
      )}
    </div>
  )
}

'use client'

// A share link's page (artifacts.md §8.3, §11.6): the artifact alone, read through the link, with no console around it.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner, Wordmark } from '@/components/marks'
import { readSharedArtifact } from '@/lib/api'
import { getUser, isAuthConfigured, resetSession } from '@/lib/auth'
import { writeFlowState } from '@/lib/flow-state'
import { artifactsContentDomain, type SharedArtifactDto } from '@/lib/artifact'
import { sharedFileUrl } from '@/lib/artifact-download'
import { sharePageProblem, shareTokenOf, type SharePageProblem } from '@/lib/artifact-share'
import { readViewerPath, VIEWER_PATH_PARAM } from '@/lib/artifact-content/viewer-path'
import { ArtifactBody } from './ArtifactBody'
import { useArtifactDownload } from './useArtifactDownload'

type Loaded = { status: 'loading' } | { status: 'ready'; shared: SharedArtifactDto } | { status: SharePageProblem }

/** Sign in, then come back to this link. */
function signInAndReturn(go: (path: string) => void): void {
  writeFlowState('returnTo', `${window.location.pathname}${window.location.search}`)
  go('/login')
}

export function SharedArtifactPage({ token: segment }: { token: string }) {
  const router = useRouter()
  const token = shareTokenOf(segment)
  const enabled = artifactsContentDomain() !== undefined
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })

  useEffect(() => {
    if (!enabled || !token) {
      setLoaded({ status: enabled ? 'notFound' : 'notEnabled' })
      return
    }
    let live = true
    setLoaded({ status: 'loading' })
    readSharedArtifact(token).then(
      (shared) => live && setLoaded({ status: 'ready', shared }),
      (error: unknown) => live && setLoaded({ status: sharePageProblem(error) })
    )
    return () => {
      live = false
    }
  }, [enabled, token])

  // An `org` link opened signed out goes through the normal sign-in and lands back here.
  const signIn = loaded.status === 'signIn'
  useEffect(() => {
    if (signIn && isAuthConfigured()) signInAndReturn((path) => router.replace(path))
  }, [signIn, router])

  if (loaded.status === 'ready')
    return token ? <SharedArtifact token={token} shared={loaded.shared} /> : <ShareProblem problem="notFound" />
  if (loaded.status === 'loading')
    return (
      <div className="flex min-h-dvh items-center justify-center bg-(--surface-app)" aria-busy="true">
        <Spinner size={36} />
      </div>
    )
  return <ShareProblem problem={loaded.status} />
}

function ShareProblem({ problem }: { problem: SharePageProblem }) {
  const t = useTranslations('Artifacts.sharePage')
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    if (problem !== 'membersOnly' || !isAuthConfigured()) return
    let live = true
    void getUser().then((user) => live && setEmail(user?.email ?? null))
    return () => {
      live = false
    }
  }, [problem])

  const switchAccount = async () => {
    writeFlowState('returnTo', `${window.location.pathname}${window.location.search}`)
    if ((await resetSession()) === 'cleared') router.replace('/login')
  }

  const copy: Record<SharePageProblem, { icon: string; title: string; body: ReactNode }> = {
    notEnabled: { icon: 'info', title: t('notEnabledTitle'), body: t('notEnabledBody') },
    revoked: { icon: 'link-2-off', title: t('revokedTitle'), body: t('revokedBody') },
    notFound: { icon: 'file-x', title: t('notFoundTitle'), body: t('notFoundBody') },
    membersOnly: {
      icon: 'lock',
      title: t('membersOnlyTitle'),
      body: email ? t('membersOnlyBodyAs', { email }) : t('membersOnlyBody')
    },
    signIn: { icon: 'log-in', title: t('signInTitle'), body: t('signInBody') },
    failed: { icon: 'triangle-exclamation-point', title: t('failedTitle'), body: t('failedBody') }
  }
  const shown = copy[problem]
  return (
    <div className="authpage" data-share-state={problem}>
      <div className="m-auto flex w-full max-w-[430px] flex-col items-center gap-5 rounded-[14px] border border-(--border-default) bg-(--surface-card) px-7 py-8 text-center font-sans shadow-(--shadow-lg)">
        <Wordmark height={30} />
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-(--surface-sunken)">
          <Icon name={shown.icon} size={22} color="var(--text-secondary)" />
        </span>
        <div>
          <h1 className="m-0 text-[18px] font-semibold leading-normal text-(--text-primary)">{shown.title}</h1>
          <p className="mt-2 mb-0 text-[13px] leading-[1.55] text-(--text-secondary)">{shown.body}</p>
        </div>
        {problem === 'membersOnly' && isAuthConfigured() ? (
          <Button variant="secondary" onClick={() => void switchAccount()}>
            {t('switchAccount')}
          </Button>
        ) : problem === 'signIn' ? (
          <Button variant="primary" onClick={() => signInAndReturn((path) => router.replace(path))}>
            {t('signIn')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function SharedArtifact({ token, shared }: { token: string; shared: SharedArtifactDto }) {
  const t = useTranslations('Artifacts.sharePage')
  const tv = useTranslations('Artifacts.viewer')
  const format = useFormatter()
  const { revision, title } = shared
  const organization = shared.organization.name
  const fileUrl = useMemo(() => sharedFileUrl(token), [token])
  const download = useArtifactDownload({ fileUrl, files: revision.manifest.files }, title)
  // Read once, client-side only: the site page to open first, so a reload keeps it.
  const [opened] = useState(() => readViewerPath(new URLSearchParams(window.location.search).get(VIEWER_PATH_PARAM)))
  const syncPath = useCallback((path: string | null) => {
    const next = new URLSearchParams(window.location.search)
    if (path === null) next.delete(VIEWER_PATH_PARAM)
    else next.set(VIEWER_PATH_PARAM, path)
    const query = next.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [])
  useEffect(() => {
    const previous = document.title
    document.title = title
    return () => {
      document.title = previous
    }
  }, [title])

  const downloadButton = (
    <Button
      variant="secondary"
      size="sm"
      disabled={download.busy}
      onClick={() => void download.run()}
      ariaLabel={tv('download')}
    >
      {download.busy ? <Spinner size={12} /> : <Icon name="download" size={14} />}
      <span className={download.busy ? '' : 'max-desktop:hidden'}>
        {download.zipping ? tv('zipping') : tv('download')}
      </span>
    </Button>
  )

  return (
    <div className="flex h-dvh flex-col bg-(--surface-app)" data-share-state="ready">
      {/* §5.5: a shared page always comes framed by who published it, since it may draw anything inside. */}
      <div
        role="note"
        data-share-ugc-banner=""
        className="flex flex-none items-start gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) desktop:items-center desktop:px-6"
      >
        <Icon
          name="shield-exclamation-point"
          size={14}
          color="var(--amber-500)"
          className="mt-[2px] flex-none desktop:mt-0"
        />
        <span>{t('ugcBanner', { organization })}</span>
      </div>
      <header className="flex flex-none items-center gap-3 px-4 py-3 desktop:px-6 desktop:py-4">
        <div className="min-w-0 flex-1">
          <h1
            className="m-0 truncate font-sans text-[17px] font-semibold leading-normal text-(--text-primary) desktop:text-[20px]"
            title={title}
          >
            {title}
          </h1>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            <span className="truncate">{organization}</span>
            <span aria-hidden>·</span>
            <span>{tv('revision', { number: revision.number })}</span>
            <span aria-hidden>·</span>
            <span title={format.dateTime(new Date(shared.sharedAt), { dateStyle: 'medium', timeStyle: 'short' })}>
              {t('sharedOn', { date: format.dateTime(new Date(shared.sharedAt), { dateStyle: 'medium' }) })}
            </span>
          </div>
        </div>
        {downloadButton}
      </header>
      {download.failed ? (
        <div
          role="alert"
          className="flex-none px-4 pb-2 font-sans text-[12px] font-medium leading-normal text-(--red-600) desktop:px-6"
        >
          {tv('downloadFailed')}
        </div>
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-(--border-subtle) bg-(--surface-card) desktop:mx-6 desktop:mb-6 desktop:rounded-md desktop:border">
        <ArtifactBody
          artifactId={shared.artifactId}
          revision={revision}
          title={title}
          download={downloadButton}
          contentDomain={artifactsContentDomain()}
          path={opened}
          onPath={syncPath}
          fileUrl={fileUrl}
        />
      </main>
    </div>
  )
}

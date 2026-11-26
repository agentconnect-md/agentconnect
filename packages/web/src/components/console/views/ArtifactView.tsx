'use client'

// The standalone artifact page (artifacts.md §8.2, §11.2): `?revision=` pins what is shown, so a reload keeps it.
import { useEffect } from 'react'
import useSWR from 'swr'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { ApiError, getArtifact } from '@/lib/api'
import { ARTIFACTS_NOT_ENABLED, artifactsContentDomain } from '@/lib/artifact'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useCrumbSlot } from '@/components/console/Shell'
import { NotFound } from '@/components/console/NotFound'
import { LoadingState } from '@/components/marks'
import { Icon } from '@/components/ui'
import { ArtifactViewer } from '@/components/console/artifact/ArtifactViewer'

/** The revision a `?revision=` value asks for, or undefined when it names none. */
export function requestedRevision(value: string | null): number | undefined {
  if (!value || !/^[1-9]\d{0,8}$/.test(value)) return undefined
  return Number(value)
}

export default function ArtifactView() {
  const t = useTranslations('Artifacts.page')
  const { id } = useParams<{ id: string }>()
  const search = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const { activeOrg, orgPath } = useOrgs()
  // A deployment without artifacts reads nothing (artifacts.md §12).
  const enabled = artifactsContentDomain() !== undefined
  const read = useSWR(
    enabled ? consoleKeys.artifact(activeOrg?.id, id) : null,
    ([, , , artifactId]) => getArtifact(artifactId),
    { shouldRetryOnError: (err) => !(err instanceof ApiError && (err.status === 404 || err.status === 409)) }
  )
  const artifact = read.data

  // The mobile push bar reads the title from this slot.
  const { register: registerCrumb } = useCrumbSlot()
  const title = artifact?.title ?? ''
  useEffect(() => {
    if (!title) return
    registerCrumb({ id, title, status: '', statusLabel: '' })
    return () => registerCrumb(null)
  }, [registerCrumb, id, title])

  if (!enabled || (read.error instanceof ApiError && read.error.code === ARTIFACTS_NOT_ENABLED))
    return (
      <div className="wrap max-desktop:p-4">
        <div
          data-testid="artifacts-not-enabled"
          className="card flex flex-col items-center gap-2 px-5 py-10 text-center font-sans text-[13px] leading-normal text-(--text-tertiary)"
        >
          <Icon name="info" size={18} color="var(--text-secondary)" />
          <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
            {t('notEnabledTitle')}
          </div>
          <p className="m-0">{t('notEnabledBody')}</p>
          <Link className="mt-2 font-medium text-(--text-link)" href={orgPath('/home')}>
            {t('backHome')}
          </Link>
        </div>
      </div>
    )

  if (!artifact) {
    // A deleted artifact and one outside the viewer's audience answer the same 404, so the copy names neither.
    if (read.error instanceof ApiError && read.error.status === 404)
      return (
        <div className="wrap max-desktop:p-4">
          <NotFound
            icon="file-x"
            kind={t('kind')}
            title={t('unavailableTitle')}
            pre={t('unavailablePre')}
            chip={id}
            post={t('unavailablePost')}
            actionLabel={t('backHome')}
            actionHref={orgPath('/home')}
            searchLabel={t('search')}
          />
        </div>
      )
    if (read.error)
      return (
        <div className="wrap max-desktop:p-4">
          <div
            role="alert"
            className="card flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] text-(--text-tertiary)"
          >
            <Icon name="triangle-exclamation-point" size={16} />
            {t('loadFailed')}
          </div>
        </div>
      )
    return <LoadingState fill />
  }

  const asked = requestedRevision(search.get('revision'))
  const kept = asked !== undefined && artifact.revisions.some((r) => r.number === asked)
  const shown = kept ? asked : (artifact.revisions[0]?.number ?? artifact.latestRevision)
  const select = (revision: number) => {
    const next = new URLSearchParams(search.toString())
    next.set('revision', String(revision))
    router.replace(`${pathname}?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="mx-auto flex h-[calc(100dvh-60px)] max-w-[1180px] flex-col max-desktop:h-[calc(100dvh-80px-env(safe-area-inset-bottom,0px))]">
      <ArtifactViewer
        artifact={artifact}
        revision={shown}
        {...(asked !== undefined && !kept ? { missing: asked } : {})}
        onRevision={select}
      />
    </div>
  )
}

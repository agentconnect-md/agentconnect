'use client'

// The Artifacts page's dialogs (artifacts.md §6.3, §11.5): rename, audience change, revisions, delete and revoking a moderated link.
import { useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { Scrim } from '@/components/console/Scrim'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { formatFileSize } from '@/components/console/FileBrowser'
import { ApiError, deleteArtifact, getArtifact, revokeArtifactShare, updateArtifact } from '@/lib/api'
import { artifactPath, type OrgArtifactDto, type OrgArtifactShareDto } from '@/lib/artifact'
import {
  ARTIFACT_TITLE_MAX,
  ARTIFACT_AUDIENCE_FIXED,
  ARTIFACT_CHANGED,
  ARTIFACT_DELETE_FORBIDDEN,
  ARTIFACT_UPDATE_FORBIDDEN
} from '@/lib/artifacts-page'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'

/** The refusal a dialog shows for a failed management call. */
function useRefusal(): (error: unknown) => string {
  const t = useTranslations('Artifacts.manage.errors')
  return (error) => {
    if (!(error instanceof ApiError)) return t('failed')
    if (error.code === ARTIFACT_UPDATE_FORBIDDEN || error.code === ARTIFACT_DELETE_FORBIDDEN || error.status === 403)
      return t('forbidden')
    if (error.code === ARTIFACT_AUDIENCE_FIXED) return t('audienceFixed')
    if (error.code === ARTIFACT_CHANGED) return t('changed')
    if (error.status === 404) return t('gone')
    return t('failed')
  }
}

function DialogFrame({
  title,
  busy,
  onClose,
  children,
  footer,
  testId
}: {
  title: string
  busy?: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  testId: string
}) {
  const t = useTranslations('Artifacts.manage')
  const titleId = useId()
  return (
    <Scrim onEscape={busy ? undefined : onClose}>
      <div
        className="modal max-w-[480px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-artifact-dialog={testId}
      >
        <div className="modalhead">
          <span id={titleId} className="min-w-0 flex-1 truncate font-sans text-[16px] font-semibold leading-normal">
            {title}
          </span>
          <button type="button" className="iconbtn" aria-label={t('close')} disabled={busy} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">{children}</div>
        {footer ? <div className="modalfoot">{footer}</div> : null}
      </div>
    </Scrim>
  )
}

function DialogError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div role="alert" className="mt-[10px] font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
      {message}
    </div>
  )
}

export function RenameArtifactDialog({
  artifact,
  onDone,
  onClose
}: {
  artifact: Pick<OrgArtifactDto, 'id' | 'title'>
  onDone: () => void
  onClose: () => void
}) {
  const t = useTranslations('Artifacts.manage')
  const refusal = useRefusal()
  const [title, setTitle] = useState(artifact.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const next = title.trim()
  const unchanged = next === artifact.title
  const save = async () => {
    if (busy || !next || unchanged) return
    setBusy(true)
    setError(null)
    try {
      await updateArtifact(artifact.id, { title: next })
      onDone()
      onClose()
    } catch (e) {
      setError(refusal(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <DialogFrame
      title={t('rename.title')}
      busy={busy}
      onClose={onClose}
      testId="rename"
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button disabled={busy || !next || unchanged} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="fld">
          <span className="fldlbl">{t('rename.label')}</span>
          <input
            className="inp"
            value={title}
            maxLength={ARTIFACT_TITLE_MAX}
            autoFocus
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      </form>
      <DialogError message={error} />
    </DialogFrame>
  )
}

export function ArtifactAudienceDialog({
  artifact,
  onDone,
  onClose
}: {
  artifact: Pick<OrgArtifactDto, 'id' | 'title' | 'audience' | 'owner'>
  onDone: () => void
  onClose: () => void
}) {
  const t = useTranslations('Artifacts.manage')
  const refusal = useRefusal()
  const { activeOrg } = useOrgs()
  const orgName = activeOrg?.name || activeOrg?.slug || ''
  const current = artifact.audience.visibility === 'org' ? 'org' : 'private'
  const [audience, setAudience] = useState<'private' | 'org'>(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy || audience === current) return
    setBusy(true)
    setError(null)
    try {
      await updateArtifact(artifact.id, { audience })
      onDone()
      onClose()
    } catch (e) {
      setError(refusal(e))
    } finally {
      setBusy(false)
    }
  }
  const choice = (value: 'private' | 'org', icon: string, label: string, hint: string) => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={audience === value}
      disabled={busy}
      data-audience={value}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-[10px] border px-4 py-3 text-left transition-colors disabled:cursor-default ${
        audience === value
          ? 'border-(--border-strong) bg-(--surface-hover)'
          : 'border-(--border-default) bg-(--surface-card) hover:border-(--border-strong)'
      }`}
      onClick={() => setAudience(value)}
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-(--surface-card) shadow-(--shadow-xs)">
        <Icon name={icon} size={17} color="var(--text-secondary)" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">{label}</span>
        <span className="mt-[2px] block font-sans text-[13px] font-normal leading-normal text-(--text-secondary)">
          {hint}
        </span>
      </span>
      {audience === value ? <Icon name="check" size={15} color="var(--text-secondary)" /> : null}
    </button>
  )
  return (
    <DialogFrame
      title={t('audienceDialog.title', { title: artifact.title })}
      busy={busy}
      onClose={onClose}
      testId="audience"
      footer={
        <>
          <div className="flex-1" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('actions.cancel')}
          </Button>
          <Button disabled={busy || audience === current} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </>
      }
    >
      <div role="radiogroup" aria-label={t('actions.audience')} className="flex flex-col gap-2">
        {choice(
          'private',
          'lock',
          t('audienceDialog.private'),
          artifact.owner ? t('audienceDialog.privateHint') : t('audienceDialog.privateHintOwners')
        )}
        {choice(
          'org',
          'users',
          t('audienceDialog.org', { org: orgName }),
          t('audienceDialog.orgHint', { org: orgName })
        )}
      </div>
      <p className="mt-3 mb-0 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
        {t('audienceDialog.sharesKept')}
      </p>
      <DialogError message={error} />
    </DialogFrame>
  )
}

export function DeleteArtifactDialog({
  artifact,
  onDone,
  onClose
}: {
  artifact: { id: string; title: string }
  onDone: () => void
  onClose: () => void
}) {
  const t = useTranslations('Artifacts.manage')
  const refusal = useRefusal()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteArtifact(artifact.id)
      onDone()
      onClose()
    } catch (e) {
      // Already gone is the outcome asked for.
      if (e instanceof ApiError && e.status === 404) {
        onDone()
        onClose()
        return
      }
      setError(refusal(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmationDialog
      title={t('delete.title', { title: artifact.title })}
      confirmLabel={t('delete.confirm')}
      busy={busy}
      busyLabel={t('delete.deleting')}
      error={error}
      destructive
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <span data-artifact-dialog="delete">{t('delete.body')}</span>
    </ConfirmationDialog>
  )
}

export function RevokePublicShareDialog({
  share,
  onDone,
  onClose
}: {
  share: Pick<OrgArtifactShareDto, 'id' | 'revision' | 'artifact'>
  onDone: () => void
  onClose: () => void
}) {
  const t = useTranslations('Artifacts.manage')
  const refusal = useRefusal()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await revokeArtifactShare(share.artifact.id, share.id)
      onDone()
      onClose()
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        onDone()
        onClose()
        return
      }
      setError(refusal(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <ConfirmationDialog
      title={t('public.revokeTitle')}
      confirmLabel={t('public.revoke')}
      busy={busy}
      busyLabel={t('public.revoking')}
      error={error}
      destructive
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <span data-artifact-dialog="revoke">
        {t('public.revokeBody', { number: share.revision, title: share.artifact.title })}
      </span>
    </ConfirmationDialog>
  )
}

export function ArtifactRevisionsDialog({
  artifact,
  onClose
}: {
  artifact: Pick<OrgArtifactDto, 'id' | 'title'>
  onClose: () => void
}) {
  const t = useTranslations('Artifacts.manage')
  const format = useFormatter()
  const { activeOrg, orgPath } = useOrgs()
  const read = useSWR(consoleKeys.artifact(activeOrg?.id, artifact.id), ([, , , id]) => getArtifact(id), {
    revalidateOnFocus: false
  })
  const revisions = read.data?.revisions
  return (
    <DialogFrame title={t('revisionsDialog.title', { title: artifact.title })} onClose={onClose} testId="revisions">
      {revisions === undefined ? (
        read.error ? (
          <div role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
            {t('revisionsDialog.loadFailed')}
          </div>
        ) : (
          <div className="flex justify-center py-4" aria-busy="true">
            <Spinner size={18} />
          </div>
        )
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-(--border-subtle) rounded-[10px] border border-(--border-default) p-0">
          {revisions.map((revision, index) => (
            <li key={revision.number}>
              <Link
                href={orgPath(artifactPath(artifact.id, revision.number))}
                data-artifact-revision={revision.number}
                className="flex items-center gap-3 px-3 py-[10px] text-(--text-primary) no-underline transition-colors hover:bg-(--surface-hover)"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-sans text-[13px] font-medium leading-normal">
                    {t('revisionsDialog.revision', { number: revision.number })}
                    {index === 0 ? (
                      <span className="badge bg-(--surface-sunken) text-[10.5px] text-(--text-secondary)">
                        {t('revisionsDialog.latest')}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                    {t('revisionsDialog.meta', {
                      date: format.dateTime(new Date(revision.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
                      agent: revision.producedBy.name,
                      size: formatFileSize(revision.totalBytes)
                    })}
                  </span>
                </span>
                <Icon name="chevron-right" size={15} color="var(--text-tertiary)" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DialogFrame>
  )
}

'use client'

// The viewer's Share dialog (artifacts.md §6.3, §8.3, §11.3): a link to the shown revision, and the artifact's existing links.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { Scrim } from '@/components/console/Scrim'
import { ApiError, createArtifactShare, listArtifactShares, revokeArtifactShare, updateArtifactShare } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { consoleKeys } from '@/lib/swr-keys'
import { platformLabel } from '@/lib/platform-labels'
import type { ArtifactDto, ArtifactShareAudience, ArtifactShareDto } from '@/lib/artifact'
import {
  ARTIFACT_REVISION_NOT_READY,
  ARTIFACT_SHARE_FORBIDDEN,
  canRevokeShare,
  canSharePublicly,
  shareLink,
  type ShareViewer
} from '@/lib/artifact-share'

export function ArtifactShareDialog({
  artifact,
  revision,
  onClose
}: {
  artifact: Pick<ArtifactDto, 'id' | 'title' | 'viewerIsOwner'>
  /** The revision the viewer shows, which a new link pins. */
  revision: number
  onClose: () => void
}) {
  // Escape the dock's and header's stacking contexts.
  return createPortal(<ShareDialogContent artifact={artifact} revision={revision} onClose={onClose} />, document.body)
}

type Pending = { kind: 'public' | 'revoke'; shareId: string } | null

function ShareDialogContent({
  artifact,
  revision,
  onClose
}: {
  artifact: Pick<ArtifactDto, 'id' | 'title' | 'viewerIsOwner'>
  revision: number
  onClose: () => void
}) {
  const t = useTranslations('Artifacts.share')
  const format = useFormatter()
  const titleId = useId()
  const { activeOrg, myRole } = useOrgs()
  const { me } = useProfile()
  const orgName = activeOrg?.name || activeOrg?.slug || ''
  const viewer: ShareViewer = { artifact, role: myRole, userId: me?.userId ?? null }
  // A 403 on a `public` create settles it even when the role read beforehand said otherwise.
  const [publicRefused, setPublicRefused] = useState(false)
  const publicAllowed = canSharePublicly(viewer) && !publicRefused
  const [audience, setAudience] = useState<ArtifactShareAudience>('org')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<{ link: string; audience: ArtifactShareAudience } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [busyShare, setBusyShare] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ shareId: string; message: string } | null>(null)

  const key = consoleKeys.artifactShares(activeOrg?.id, artifact.id)
  const list = useSWR(key, ([, , , id]) => listArtifactShares(id), { revalidateOnFocus: false })

  const refusal = (e: unknown): string => {
    if (e instanceof ApiError && e.code === ARTIFACT_SHARE_FORBIDDEN) return t('forbidden')
    if (e instanceof ApiError && e.code === ARTIFACT_REVISION_NOT_READY) return t('notReady')
    return e instanceof Error && e.message ? e.message : t('failed')
  }

  const create = async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    setCreated(null)
    try {
      const share = await createArtifactShare(artifact.id, { revision, audience })
      setCreated({ link: shareLink(share, window.location.origin), audience })
      const { token: _token, linkPath: _path, link: _link, ...listed } = share
      void list.mutate((shares) => [listed, ...(shares ?? []).filter((s) => s.id !== share.id)], { revalidate: false })
    } catch (e) {
      if (e instanceof ApiError && e.code === ARTIFACT_SHARE_FORBIDDEN && audience === 'public') {
        setPublicRefused(true)
        setAudience('org')
      }
      setError(refusal(e))
    } finally {
      setCreating(false)
    }
  }

  const changeAudience = async (share: ArtifactShareDto, next: ArtifactShareAudience) => {
    setPending(null)
    setBusyShare(share.id)
    setRowError(null)
    try {
      const updated = await updateArtifactShare(artifact.id, share.id, next)
      void list.mutate((shares) => (shares ?? []).map((s) => (s.id === updated.id ? updated : s)), {
        revalidate: false
      })
    } catch (e) {
      setRowError({ shareId: share.id, message: refusal(e) })
    } finally {
      setBusyShare(null)
    }
  }

  const revoke = async (share: ArtifactShareDto) => {
    setPending(null)
    setBusyShare(share.id)
    setRowError(null)
    try {
      await revokeArtifactShare(artifact.id, share.id)
      void list.mutate((shares) => (shares ?? []).filter((s) => s.id !== share.id), { revalidate: false })
    } catch (e) {
      setRowError({ shareId: share.id, message: refusal(e) })
    } finally {
      setBusyShare(null)
    }
  }

  const audienceLabel = (value: ArtifactShareAudience) =>
    value === 'public' ? t('audience.public') : t('audience.org', { org: orgName })

  const creatorOf = (share: ArtifactShareDto): string => {
    const by = share.createdBy
    if (by.userId && by.userId === me?.userId) return t('you')
    if (by.displayName || by.email) return (by.displayName || by.email)!
    if (by.platform) return platformLabel(by.platform)?.name ?? by.platform
    return t('unknownCreator')
  }

  const choice = (value: ArtifactShareAudience, icon: string, description: string, disabled: boolean) => (
    <button
      key={value}
      type="button"
      role="radio"
      aria-checked={audience === value}
      disabled={disabled || creating}
      data-share-audience={value}
      className={`flex w-full items-center gap-3 rounded-[10px] border px-4 py-3 text-left transition-colors ${
        audience === value
          ? 'border-(--border-strong) bg-(--surface-hover)'
          : 'border-(--border-default) bg-(--surface-card) hover:border-(--border-strong)'
      } disabled:cursor-default ${disabled ? 'opacity-60 hover:border-(--border-default)' : 'cursor-pointer'}`}
      onClick={() => {
        setAudience(value)
        setCreated(null)
        setError(null)
      }}
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-(--surface-card) shadow-(--shadow-xs)">
        <Icon name={icon} size={17} color="var(--text-secondary)" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
          {audienceLabel(value)}
        </span>
        <span className="mt-[2px] block font-sans text-[13px] font-normal leading-normal text-(--text-secondary)">
          {description}
        </span>
      </span>
      {audience === value ? <Icon name="check" size={15} color="var(--text-secondary)" /> : null}
    </button>
  )

  const shares = list.data
  return (
    <Scrim onEscape={onClose}>
      <div
        className="modal max-w-[560px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-artifact-share-dialog=""
      >
        <div className="modalhead">
          <span id={titleId} className="min-w-0 flex-1 truncate font-sans text-[18px] font-semibold leading-normal">
            {t('title', { title: artifact.title })}
          </span>
          <button type="button" className="iconbtn" aria-label={t('close')} title={t('close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-4">
          <section className="flex flex-col gap-2">
            <div
              id={`${titleId}-new`}
              className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
            >
              {t('newLink', { number: revision })}
            </div>
            <div role="radiogroup" aria-labelledby={`${titleId}-new`} className="flex flex-col gap-2">
              {choice('org', 'users', t('audience.orgHint', { org: orgName }), false)}
              {choice(
                'public',
                'globe',
                publicAllowed ? t('audience.publicHint') : t('publicNotAllowed'),
                !publicAllowed
              )}
            </div>
            {audience === 'public' ? <RecallNotice>{t('recallNotice')}</RecallNotice> : null}
            {error ? (
              <div role="alert" className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
                {error}
              </div>
            ) : null}
            {created ? (
              <CreatedLink link={created.link} label={audienceLabel(created.audience)} />
            ) : (
              <div className="flex justify-end">
                <Button variant="primary" disabled={creating} onClick={() => void create()}>
                  {creating ? <Spinner size={15} /> : <Icon name="link" size={15} />}
                  {audience === 'public' ? t('createPublic') : t('create')}
                </Button>
              </div>
            )}
          </section>
          <section className="flex flex-col gap-2" aria-labelledby={`${titleId}-links`}>
            <div
              id={`${titleId}-links`}
              className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)"
            >
              {t('links')}
            </div>
            {shares === undefined ? (
              list.error ? (
                <div role="alert" className="font-sans text-[12.5px] font-normal leading-normal text-(--status-error)">
                  {t('listFailed')}
                </div>
              ) : (
                <div className="flex justify-center py-4" aria-busy="true">
                  <Spinner size={18} />
                </div>
              )
            ) : shares.length === 0 ? (
              <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                {t('noLinks')}
              </div>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-(--border-subtle) rounded-[10px] border border-(--border-default) p-0">
                {shares.map((share) => {
                  const next: ArtifactShareAudience = share.audience === 'public' ? 'org' : 'public'
                  // Either direction needs the `public` right (§6.3); a refused `public` create hides only the widening.
                  const mayChange = next === 'public' ? publicAllowed : canSharePublicly(viewer)
                  const mayRevoke = canRevokeShare(viewer, share)
                  const busy = busyShare === share.id
                  return (
                    <li key={share.id} data-artifact-share={share.id} className="flex flex-col gap-2 px-3 py-[10px]">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <Icon
                          name={share.audience === 'public' ? 'globe' : 'users'}
                          size={16}
                          color="var(--text-secondary)"
                          className="flex-none"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2 font-sans text-[13px] font-medium leading-normal text-(--text-primary)">
                            <span className="truncate">{audienceLabel(share.audience)}</span>
                            <span className="mono flex-none text-[11.5px] text-(--text-tertiary)">
                              {share.displayTail}
                            </span>
                          </div>
                          <div className="truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                            {t('shareMeta', {
                              number: share.revision,
                              creator: creatorOf(share),
                              date: format.dateTime(new Date(share.createdAt), { dateStyle: 'medium' })
                            })}
                          </div>
                        </div>
                        <div className="flex flex-none items-center gap-2">
                          {busy ? <Spinner size={14} /> : null}
                          {mayChange ? (
                            <Button
                              variant="secondary"
                              size="xs"
                              disabled={busy}
                              onClick={() =>
                                next === 'public'
                                  ? setPending({ kind: 'public', shareId: share.id })
                                  : void changeAudience(share, next)
                              }
                            >
                              {next === 'public' ? t('makePublic') : t('makeOrg')}
                            </Button>
                          ) : null}
                          {mayRevoke ? (
                            <Button
                              variant="ghost"
                              size="xs"
                              disabled={busy}
                              className="text-(--status-error)"
                              onClick={() => setPending({ kind: 'revoke', shareId: share.id })}
                            >
                              {t('revoke')}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {pending?.shareId === share.id ? (
                        <div
                          data-artifact-share-confirm={pending.kind}
                          className="flex flex-col gap-2 rounded-md bg-(--surface-sunken) px-3 py-2"
                        >
                          <p className="m-0 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
                            {pending.kind === 'public' ? t('recallNotice') : t('revokeConfirm')}
                          </p>
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="xs" onClick={() => setPending(null)}>
                              {t('cancel')}
                            </Button>
                            <Button
                              variant={pending.kind === 'public' ? 'primary' : 'danger'}
                              size="xs"
                              onClick={() =>
                                pending.kind === 'public' ? void changeAudience(share, 'public') : void revoke(share)
                              }
                            >
                              {pending.kind === 'public' ? t('makePublic') : t('revoke')}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {rowError?.shareId === share.id ? (
                        <div
                          role="alert"
                          className="font-sans text-[12px] font-normal leading-normal text-(--status-error)"
                        >
                          {rowError.message}
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Scrim>
  )
}

function RecallNotice({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      data-artifact-share-recall=""
      className="flex items-start gap-2 rounded-md border border-(--border-subtle) bg-(--status-paused-soft) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)"
    >
      <Icon name="triangle-exclamation-point" size={14} color="var(--amber-500)" className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

/** The new link, shown once: listed shares carry only the token's tail. */
function CreatedLink({ link, label }: { link: string; label: string }) {
  const t = useTranslations('Artifacts.share')
  const input = useRef<HTMLInputElement | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setCopyFailed(false)
    } catch {
      setCopyFailed(true)
      input.current?.select()
    }
  }
  return (
    <div data-artifact-share-created="" className="flex flex-col gap-2">
      <div className="font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
        {t('createdNotice', { audience: label })}
      </div>
      <div className="flex items-center gap-2">
        <input
          ref={input}
          className="inp min-w-0 flex-1 font-mono text-[12px]"
          aria-label={t('linkLabel')}
          value={link}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button variant="primary" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} size={15} />
          {copied ? t('copied') : t('copy')}
        </Button>
      </div>
      {copyFailed ? (
        <div role="alert" className="font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          {t('copyFailed')}
        </div>
      ) : null}
    </div>
  )
}

'use client'

// Computer detail (computer-use.md §10): an overview of screen, checks, details and agent access, then policy and activity tabs.
import { useEffect, useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import {
  deleteComputer,
  resetComputer,
  resumeComputer,
  revokeComputer,
  setComputerSharing,
  sleepComputer,
  stopComputer,
  wakeComputer,
  type ComputerDto
} from '@/lib/api'
import { computerStatusTone, useComputer, useAgo } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { NotFound } from '@/components/console/NotFound'
import { useCrumbSlot } from '@/components/console/Shell'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { Scrim } from '@/components/console/Scrim'
import { VisibilityField, VisibilityValue, sameSharing, type SharingValue } from '@/components/console/VisibilityField'
import { useAgentName, useMemberName } from '@/components/console/computer-members'
import { ComputerActivityCard, ComputerDoctorCard } from '@/components/console/ComputerCards'
import { ComputerPolicyCard } from '@/components/console/ComputerPolicyCard'
import { ComputerAgentAccessCard } from '@/components/console/ComputerAgentAccessCard'
import { ComputerViewerCard } from '@/components/console/ComputerViewer'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type Confirm = 'revoke' | 'delete' | 'reset' | null

export default function ComputerDetailView() {
  const t = useTranslations('Computers')
  const params = useParams<{ id: string }>()
  const id = params?.id
  const { orgPath } = useOrgs()
  // Off, a deep link reads as not found without fetching the Computer.
  const offered = featureFlagEnabled('computer-use')
  const { data: computer, error, isLoading, mutate } = useComputer(offered ? id : undefined)
  // The mobile push bar reads the title from this slot.
  const { register: registerCrumb } = useCrumbSlot()
  const title = computer?.name ?? ''
  useEffect(() => {
    if (!title || !id) return
    registerCrumb({ id, title, status: '', statusLabel: '' })
    return () => registerCrumb(null)
  }, [registerCrumb, id, title])
  if (!computer) {
    if (isLoading || (offered && !error && id)) return <LoadingState fill />
    return (
      <div className="wrap px-4 pt-[14px] desktop:p-0">
        <NotFound
          icon="monitor-off"
          kind="COMPUTER"
          title={t('detail.notFound')}
          pre={`${t('detail.notFoundPre')} `}
          chip={id}
          post={t('detail.notFoundPost')}
          actionLabel={t('detail.back')}
          actionHref={orgPath('/daemons#computers')}
        />
      </div>
    )
  }
  return (
    <ComputerDetail
      computer={computer}
      onChanged={(next) => void mutate(next, { revalidate: false })}
      onRefresh={() => void mutate()}
    />
  )
}

// The desktop reports a stop or resume in the heartbeat it sends right away, so re-read shortly after one.
const SETTLE_MS = 1500

type Tab = 'overview' | 'policy' | 'activity'

function ComputerDetail({
  computer,
  onChanged,
  onRefresh
}: {
  computer: ComputerDto
  onChanged: (next: ComputerDto) => void
  onRefresh: () => void
}) {
  const t = useTranslations('Computers')
  const format = useFormatter()
  const ago = useAgo()
  const router = useRouter()
  const search = useSearchParams()
  const { orgPath } = useOrgs()
  const memberName = useMemberName()
  const agentName = useAgentName()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editingVisibility, setEditingVisibility] = useState(false)
  const showActivity = computer.canEditPolicy
  const asked = search?.get('tab')
  const [tab, setTab] = useState<Tab>(asked === 'policy' || (asked === 'activity' && showActivity) ? asked : 'overview')
  const changeTab = (next: Tab) => {
    setTab(next)
    const url = new URL(window.location.href)
    if (next === 'overview') url.searchParams.delete('tab')
    else url.searchParams.set('tab', next)
    window.history.replaceState(window.history.state, '', url)
  }
  const tone = computerStatusTone(computer.status)
  const revoked = computer.status === 'revoked'
  const stopped = computer.stoppedAt !== null && !revoked
  const canStop = computer.canEdit && !revoked && !stopped
  const canResume = computer.canEditPolicy && stopped
  const pool = computer.poolActions ?? { wake: false, sleep: false, reset: false }
  const hasPoolActions = Boolean(computer.allocation) && (pool.wake || pool.sleep || pool.reset)

  const run = async (action: () => Promise<ComputerDto | void>, after?: () => void) => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    try {
      const next = await action()
      if (next) onChanged(next)
      setConfirm(null)
      after?.()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const pick = (action: () => void) => () => {
    setMenuOpen(false)
    action()
  }

  const seen = computer.lastSeenAt ? ago(computer.lastSeenAt) : t('never')
  const display = computer.capabilities.displays[0]
  const lease = computer.lease ?? null
  const waiting = computer.waiting ?? []

  const stopButton = canStop ? (
    <Button
      variant="secondary"
      size="sm"
      className="text-(--status-error) hover:border-(--status-error) hover:bg-(--status-error-soft)"
      disabled={busy}
      onClick={() =>
        void run(
          () => stopComputer(computer.id),
          () => setTimeout(onRefresh, SETTLE_MS)
        )
      }
    >
      <Icon name="octagon-x" size={14} />
      {t('actions.stop')}
    </Button>
  ) : canResume ? (
    <Button
      variant="primary"
      size="sm"
      disabled={busy}
      onClick={() =>
        void run(
          () => resumeComputer(computer.id),
          () => setTimeout(onRefresh, SETTLE_MS)
        )
      }
    >
      <Icon name="play" size={14} />
      {t('actions.resume')}
    </Button>
  ) : null

  // Who has control and who waits (§4.4), beside the screen.
  const control = (
    <span className="flex min-w-0 items-center gap-[6px]" data-lease-holder={lease?.agentId}>
      <Icon name={lease ? 'mouse-pointer-2' : 'hand'} size={13} className="flex-none" />
      <span className="truncate">
        {lease ? (
          <Link
            className="text-(--text-secondary) hover:underline"
            href={orgPath(`/sessions/${encodeURIComponent(lease.sessionId)}`)}
            title={t('lease.since', { when: ago(lease.acquiredAt) })}
          >
            {t('lease.holderLine', { agent: agentName(lease.agentId, lease.agentName) })}
          </Link>
        ) : (
          t('lease.free')
        )}
        {' · '}
        <span title={waiting.map((w) => agentName(w.agentId)).join('\n') || undefined} data-lease-waiting>
          {t('waitingCount', { count: waiting.length })}
        </span>
      </span>
    </span>
  )

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: t('detail.tabs.overview') },
    { key: 'policy', label: t('policy.title') },
    ...(showActivity ? [{ key: 'activity' as const, label: t('activity.title') }] : [])
  ]

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-6 desktop:p-0">
      {/* Header: on mobile the Shell push bar carries the name, so the title row is desktop-only. */}
      <div className="mb-[6px] flex items-start gap-[14px]">
        <span className="relative hidden h-11 w-11 flex-none items-center justify-center rounded-[10px] border border-(--border-subtle) bg-(--surface-sunken) desktop:flex">
          <Icon name="monitor" size={22} color={revoked ? 'var(--text-tertiary)' : 'var(--brand)'} />
          <span
            className="absolute -right-[3px] -bottom-[3px] h-[10px] w-[10px] rounded-full shadow-[0_0_0_2px_var(--surface-app)]"
            style={{ background: tone.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-[9px]">
            <h1 className="m-0 hidden font-sans text-[20px] font-semibold leading-normal tracking-[-0.01em] text-(--text-primary) desktop:block">
              {computer.name}
            </h1>
            <span className="badge flex-none" style={{ background: tone.bg, color: tone.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: tone.dot }} />
              {t(`status.${computer.status}`)}
            </span>
            {computer.allocation && (
              <span
                className="inline-flex h-[22px] flex-none items-center gap-[5px] rounded-full border border-(--border-default) px-2 font-sans text-[11.5px] font-medium leading-normal text-(--text-secondary)"
                title={t(`pool.hint.${computer.allocation}`, { agent: agentName(computer.ownerAgentId) })}
                data-pool-chip
              >
                <Icon name="layers" size={12} />
                {t(`allocation.${computer.allocation}`)}
                {computer.poolPhase && <> · {t(`poolPhase.${computer.poolPhase}`)}</>}
              </span>
            )}
          </div>
          <div className="mt-[6px] flex flex-wrap items-center gap-x-4 gap-y-1 font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
            <span className="mono text-(--text-secondary)">{computer.id}</span>
            <Meta icon="cpu">
              {t(`os.${computer.os}`)} {computer.osVersion}
            </Meta>
            <Meta icon="app-window">{t(`session.${computer.session}`)}</Meta>
            <Meta icon="tag">
              <span className="mono">{computer.desktopDaemonVersion}</span>
            </Meta>
            <Meta icon="timer">
              <span className="mono">{revoked ? t('revoked') : t('lastSeen', { when: seen })}</span>
            </Meta>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <span className="hidden desktop:inline-flex">{stopButton}</span>
          {(computer.canEdit || hasPoolActions) && (
            <div className="relative">
              <button
                type="button"
                className="iconbtn"
                aria-label={t('actions.more')}
                title={t('actions.more')}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Icon name="ellipsis" size={16} />
              </button>
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-45" />
                  <div className="dmenu right-0" role="menu" onClick={(e) => e.stopPropagation()}>
                    {hasPoolActions && (
                      <>
                        {pool.wake && (
                          <button
                            role="menuitem"
                            className="dmi"
                            disabled={busy}
                            onClick={pick(() => void run(() => wakeComputer(computer.id)))}
                          >
                            <Icon name="sunrise" size={15} />
                            {t('pool.wake')}
                          </button>
                        )}
                        {pool.sleep && (
                          <button
                            role="menuitem"
                            className="dmi"
                            disabled={busy}
                            onClick={pick(() => void run(() => sleepComputer(computer.id)))}
                          >
                            <Icon name="moon" size={15} />
                            {t('pool.sleep')}
                          </button>
                        )}
                        {pool.reset && (
                          <button role="menuitem" className="dmi" onClick={pick(() => setConfirm('reset'))}>
                            <Icon name="rotate-ccw" size={15} />
                            {t('pool.reset')}
                          </button>
                        )}
                        {computer.canEdit && <div className="dmsep" />}
                      </>
                    )}
                    {computer.canEdit && !revoked && (
                      <button role="menuitem" className="dmi danger" onClick={pick(() => setConfirm('revoke'))}>
                        <Icon name="shield-off" size={15} />
                        {t('actions.revoke')}
                      </button>
                    )}
                    {computer.canEdit && (
                      <button role="menuitem" className="dmi danger" onClick={pick(() => setConfirm('delete'))}>
                        <Icon name="trash" size={15} />
                        {t('actions.delete')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile keeps the primary action in the body, full width and thumb-sized. */}
      {stopButton && (
        <div className="mt-3 mb-1 flex desktop:hidden [&>button]:h-11 [&>button]:flex-1">{stopButton}</div>
      )}

      <div
        className="mb-4 flex items-end overflow-x-auto border-b border-(--border-subtle) desktop:mb-[18px]"
        role="tablist"
      >
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? 'tab on whitespace-nowrap' : 'tab whitespace-nowrap'}
            onClick={() => changeTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {actionError && !confirm && (
        <Banner tone="error" icon="triangle-alert">
          {actionError}
        </Banner>
      )}
      {revoked && (
        <Banner tone="error" icon="shield-off">
          {t('detail.revokedBanner')}
        </Banner>
      )}
      {stopped && (
        <Banner tone="paused" icon="octagon-x">
          {t('detail.stoppedBanner', {
            name: memberName(computer.stoppedByUserId),
            when: ago(computer.stoppedAt!)
          })}
          {!computer.canEditPolicy && <> {t('detail.stoppedOwnerResumes')}</>}
        </Banner>
      )}
      {computer.status === 'human_in_control' && (
        <Banner tone="paused" icon="hand">
          {t('detail.humanBanner')}
        </Banner>
      )}

      {tab === 'overview' && (
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex min-w-0 flex-[1.55_1_460px] flex-col gap-4">
            <ComputerViewerCard computer={computer} control={control} />
            <ComputerDoctorCard computer={computer} />
          </div>
          <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-4">
            <div className="card overflow-hidden max-desktop:rounded-lg">
              <div className="cardhead">
                <span className="cardtitle">{t('detail.details')}</span>
              </div>
              <div className="-mt-px">
                <Row label={t('detail.owner')}>{memberName(computer.ownerUserId)}</Row>
                <Row label={t('detail.kind')}>
                  {t(`kind.${computer.kind}`)} · {t(`isolation.${computer.isolation}`)}
                </Row>
                {computer.allocation && (
                  <>
                    <Row label={t('detail.allocation')}>{t(`detail.allocationValue.${computer.allocation}`)}</Row>
                    {computer.ownerAgentId && (
                      <Row label={t('detail.ownerAgent')}>{agentName(computer.ownerAgentId)}</Row>
                    )}
                    <Row label={t('pool.phase')}>
                      <span data-pool-phase={computer.poolPhase ?? ''}>
                        {computer.poolPhase ? t(`poolPhase.${computer.poolPhase}`) : '—'}
                      </span>
                    </Row>
                    {computer.poolError && (
                      <Row label={t('pool.error')}>
                        <span className="text-(--status-error)" title={computer.poolError}>
                          {computer.poolError}
                        </span>
                      </Row>
                    )}
                  </>
                )}
                <Row label={t('detail.display')} mono>
                  {display ? `${display.width}×${display.height} @${display.scale}x` : t('detail.unknown')}
                </Row>
                <Row label={t('detail.input')}>
                  {!computer.capabilities.input
                    ? t('detail.inputNone')
                    : computer.capabilities.textInput === 'full'
                      ? t('detail.inputFull')
                      : t('detail.inputKeymap')}
                </Row>
                <Row label={t('detail.activity')}>
                  {computer.capabilities.humanActivity === 'pointer+keyboard'
                    ? t('detail.activityKeyboard')
                    : t('detail.activityPointer')}
                </Row>
                <Row label={t('detail.viewer')}>
                  {computer.capabilities.viewer ? t('detail.available') : t('detail.unavailable')}
                </Row>
                <Row label={t('detail.driver')} mono>
                  {computer.driverVersion}
                </Row>
                <Row label={t('detail.screenshots')}>
                  {computer.screenshotRetentionDays > 0
                    ? t('detail.retention', { days: computer.screenshotRetentionDays })
                    : t('detail.notStored')}
                </Row>
                <Row label={t('detail.registered')}>
                  {format.dateTime(new Date(computer.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
                </Row>
                <div className="flex min-h-10 items-center gap-3 border-t border-(--border-subtle) pr-[10px] pl-4">
                  <span className="w-[108px] flex-none font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                    {t('detail.visibility')}
                  </span>
                  <span className="flex-1" />
                  {computer.canEdit && !revoked ? (
                    <button
                      type="button"
                      className="inline-flex h-7 min-w-0 cursor-pointer items-center gap-[6px] rounded-sm border border-transparent bg-transparent px-[9px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) hover:border-(--border-default) hover:bg-(--surface-hover)"
                      title={t('visibilityEdit.open')}
                      aria-label={t('visibilityEdit.open')}
                      onClick={() => setEditingVisibility(true)}
                    >
                      <VisibilityValue visibility={computer.visibility} sharedWith={computer.sharedWith} />
                      <Icon name="pencil" size={13} color="var(--text-tertiary)" />
                    </button>
                  ) : (
                    <span className="min-w-0 pr-[6px] font-sans text-[12.5px] font-medium leading-normal">
                      <VisibilityValue visibility={computer.visibility} sharedWith={computer.sharedWith} />
                    </span>
                  )}
                </div>
              </div>
            </div>
            <ComputerAgentAccessCard computer={computer} />
          </div>
        </div>
      )}

      {/* Kept mounted while hidden, so an unsaved draft survives a look at another tab. */}
      <div hidden={tab !== 'policy'}>
        <ComputerPolicyCard computer={computer} onSaved={onChanged} />
      </div>

      {tab === 'activity' && showActivity && <ComputerActivityCard computer={computer} />}

      {editingVisibility && (
        <VisibilityDialog
          computer={computer}
          onSaved={(next) => {
            onChanged(next)
            setEditingVisibility(false)
          }}
          onClose={() => setEditingVisibility(false)}
        />
      )}
      {confirm === 'reset' && (
        <ConfirmationDialog
          title={t('pool.resetTitle')}
          confirmLabel={t('pool.resetConfirm')}
          busyLabel={t('pool.resetBusy')}
          busy={busy}
          error={actionError}
          destructive
          onConfirm={() => void run(() => resetComputer(computer.id))}
          onClose={() => setConfirm(null)}
        >
          {t('pool.resetBody', { name: computer.name })}
        </ConfirmationDialog>
      )}
      {confirm === 'revoke' && (
        <ConfirmationDialog
          title={t('revoke.title')}
          confirmLabel={t('revoke.confirm')}
          busyLabel={t('revoke.busy')}
          busy={busy}
          error={actionError}
          destructive
          onConfirm={() => void run(() => revokeComputer(computer.id))}
          onClose={() => setConfirm(null)}
        >
          {t('revoke.body', { name: computer.name })}
        </ConfirmationDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmationDialog
          title={t('delete.title')}
          confirmLabel={t('delete.confirm')}
          busyLabel={t('delete.busy')}
          busy={busy}
          error={actionError}
          destructive
          onConfirm={() =>
            void run(
              () => deleteComputer(computer.id),
              () => router.push(orgPath('/daemons#computers'))
            )
          }
          onClose={() => setConfirm(null)}
        >
          {t('delete.body', { name: computer.name })}
        </ConfirmationDialog>
      )}
    </div>
  )
}

/** Who sees the Computer, and so who may give it to their agents (computer-use.md §4.1). */
function VisibilityDialog({
  computer,
  onSaved,
  onClose
}: {
  computer: ComputerDto
  onSaved: (next: ComputerDto) => void
  onClose: () => void
}) {
  const t = useTranslations('Computers.visibilityEdit')
  const titleId = useId()
  const initial: SharingValue = { visibility: computer.visibility, sharedWith: computer.sharedWith }
  const [sharing, setSharing] = useState<SharingValue>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (saving) return
    if (sameSharing(sharing, initial)) return onClose()
    setSaving(true)
    setError(null)
    try {
      onSaved(await setComputerSharing(computer.id, sharing))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSaving(false)
    }
  }
  return (
    <Scrim onEscape={saving ? undefined : onClose}>
      <div className="modal max-w-[520px]" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="monitor" size={17} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {t('title')}
          </span>
          <button type="button" className="iconbtn" aria-label={t('cancel')} disabled={saving} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <p className="m-0 font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
            {t('description')}
          </p>
          <VisibilityField value={sharing} onChange={setSharing} disabled={saving} />
          {error && (
            <div role="alert" className="mt-[10px] font-sans text-[12px] leading-[1.5] text-(--status-error)">
              {error}
            </div>
          )}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void save()}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}

function Meta({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[5px]">
      <Icon name={icon} size={13} />
      {children}
    </span>
  )
}

function Row({ label, mono = false, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 border-t border-(--border-subtle) px-4 py-[6px]">
      <span className="w-[108px] flex-none font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
        {label}
      </span>
      <span
        className={
          mono
            ? 'min-w-0 flex-1 truncate text-right font-mono text-[12.5px] font-medium leading-normal text-(--text-primary)'
            : 'min-w-0 flex-1 truncate text-right font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)'
        }
      >
        {children}
      </span>
    </div>
  )
}

function Banner({ tone, icon, children }: { tone: 'error' | 'paused'; icon: string; children: ReactNode }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={
        tone === 'error'
          ? 'mb-4 flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)'
          : 'mb-4 flex items-start gap-2 rounded-md border border-(--status-paused) bg-(--status-paused-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-[#9a6500]'
      }
    >
      <Icon name={icon} size={15} className="mt-[1px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

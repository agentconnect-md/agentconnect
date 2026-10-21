'use client'

// Computer detail (computer-use.md §10): viewer, status, doctor with fixes, agent access, policy, stop / resume, revoke, and activity.
import { useEffect, useState, type ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { deleteComputer, resumeComputer, revokeComputer, stopComputer, type ComputerDto } from '@/lib/api'
import { computerStatusTone, poolPhaseNote, useComputer, useAgo } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { NotFound } from '@/components/console/NotFound'
import { useCrumbSlot } from '@/components/console/Shell'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { VisibilityValue } from '@/components/console/VisibilityField'
import { useMemberName } from '@/components/console/computer-members'
import { ComputerActivityCard, ComputerDoctorCard } from '@/components/console/ComputerCards'
import { ComputerPolicyCard } from '@/components/console/ComputerPolicyCard'
import { ComputerAgentAccessCard } from '@/components/console/ComputerAgentAccessCard'
import { ComputerViewerCard } from '@/components/console/ComputerViewer'
import { AllocationBadge, ComputerLeaseCard, ComputerPoolCard } from '@/components/console/ComputerPoolCards'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

type Confirm = 'revoke' | 'delete' | null

export default function ComputerDetailView() {
  const t = useTranslations('Computers')
  const params = useParams<{ id: string }>()
  const id = params?.id
  const { orgPath } = useOrgs()
  const { data: computer, error, isLoading, mutate } = useComputer(id)
  // The mobile push bar reads the title from this slot.
  const { register: registerCrumb } = useCrumbSlot()
  const title = computer?.name ?? ''
  useEffect(() => {
    if (!title || !id) return
    registerCrumb({ id, title, status: '', statusLabel: '' })
    return () => registerCrumb(null)
  }, [registerCrumb, id, title])
  if (!computer) {
    if (isLoading || (!error && id)) return <LoadingState fill />
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
          actionHref={orgPath('/computers')}
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
  const { orgPath } = useOrgs()
  const memberName = useMemberName()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const tone = computerStatusTone(computer.status)
  const revoked = computer.status === 'revoked'
  const stopped = computer.stoppedAt !== null && !revoked
  const canStop = computer.canEdit && !revoked && !stopped
  const canResume = computer.canEditPolicy && stopped

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

  const seen = computer.lastSeenAt ? ago(computer.lastSeenAt) : t('never')
  const poolNote = poolPhaseNote(computer)
  const display = computer.capabilities.displays[0]

  const stopButton = canStop ? (
    <Button
      variant="danger"
      size="sm"
      disabled={busy}
      onClick={() =>
        void run(
          () => stopComputer(computer.id),
          () => setTimeout(onRefresh, SETTLE_MS)
        )
      }
    >
      <Icon name="octagon-x" size={15} />
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
      <Icon name="play" size={15} />
      {t('actions.resume')}
    </Button>
  ) : null

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-6 desktop:p-0">
      {/* Header: on mobile the Shell push bar carries the name, so the title row is desktop-only. */}
      <div className="mb-4 flex items-start gap-4 desktop:mb-5">
        <span className="relative hidden h-13 w-13 flex-none items-center justify-center rounded-lg border border-(--border-subtle) bg-(--surface-sunken) desktop:flex">
          <Icon name="monitor" size={26} color={revoked ? 'var(--text-tertiary)' : 'var(--brand)'} />
          <span
            className="absolute -right-1 -bottom-1 h-[14px] w-[14px] rounded-full border-[2.5px] border-(--surface-app)"
            style={{ background: tone.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h1 className="ptitle hidden desktop:block">{computer.name}</h1>
            <span className="badge" style={{ background: tone.bg, color: tone.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: tone.dot }} />
              {t(`status.${computer.status}`)}
            </span>
            {poolNote && (
              <span className="font-sans text-[12px] font-medium leading-normal text-(--text-tertiary)">
                {t(`poolPhase.${poolNote}`)}
              </span>
            )}
            <AllocationBadge computer={computer} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Meta icon="monitor">
              {t(`os.${computer.os}`)} {computer.osVersion}
            </Meta>
            <Meta icon="app-window">{t(`session.${computer.session}`)}</Meta>
            <Meta icon="tag">
              <span className="mono text-[12px]">{computer.desktopDaemonVersion}</span>
            </Meta>
            <Meta icon="timer">{revoked ? t('revoked') : t('lastSeen', { when: seen })}</Meta>
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          <span className="hidden desktop:inline-flex">{stopButton}</span>
          {computer.canEdit && (
            <div className="relative">
              <button
                type="button"
                className="iconbtn"
                aria-label={t('actions.more')}
                title={t('actions.more')}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Icon name="ellipsis" size={16} />
              </button>
              {menuOpen && (
                <>
                  <div onClick={() => setMenuOpen(false)} className="fixed inset-0 z-45" />
                  <div className="dmenu right-0" role="menu" onClick={(e) => e.stopPropagation()}>
                    {!revoked && (
                      <button
                        role="menuitem"
                        className="dmi danger"
                        onClick={() => {
                          setMenuOpen(false)
                          setConfirm('revoke')
                        }}
                      >
                        <Icon name="shield-off" size={15} />
                        {t('actions.revoke')}
                      </button>
                    )}
                    <button
                      role="menuitem"
                      className="dmi danger"
                      onClick={() => {
                        setMenuOpen(false)
                        setConfirm('delete')
                      }}
                    >
                      <Icon name="trash" size={15} />
                      {t('actions.delete')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Mobile keeps the primary action in the body, full width and thumb-sized. */}
      {stopButton && <div className="mb-3 flex desktop:hidden [&>button]:h-11 [&>button]:flex-1">{stopButton}</div>}

      {actionError && (
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

      <div className="mb-4 desktop:mb-[18px]">
        <ComputerViewerCard computer={computer} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 desktop:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] desktop:gap-[18px]">
        <ComputerDoctorCard computer={computer} />
        <div className="card overflow-hidden max-desktop:rounded-lg">
          <div className="cardhead">
            <span className="cardtitle">{t('detail.details')}</span>
          </div>
          <div className="py-[6px]">
            <Row label={t('detail.owner')}>{memberName(computer.ownerUserId)}</Row>
            <Row label={t('detail.kind')}>
              {t(`kind.${computer.kind}`)} · {t(`isolation.${computer.isolation}`)}
            </Row>
            <Row label={t('detail.display')}>
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
            <Row label={t('detail.driver')}>
              <span className="mono text-[12px]">{computer.driverVersion}</span>
            </Row>
            <Row label={t('detail.screenshots')}>
              {computer.screenshotRetentionDays > 0
                ? t('detail.retention', { days: computer.screenshotRetentionDays })
                : t('detail.notStored')}
            </Row>
            <Row label={t('detail.registered')}>
              {format.dateTime(new Date(computer.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
            </Row>
            <Row label={t('detail.visibility')}>
              <span className="flex justify-end">
                <VisibilityValue visibility={computer.visibility} sharedWith={computer.sharedWith} />
              </span>
            </Row>
          </div>
        </div>
      </div>

      {/* Who has control and who waits; a managed computer adds its pool state and actions beside it. */}
      <div
        className={
          computer.allocation
            ? 'mt-4 grid grid-cols-1 items-start gap-4 desktop:mt-[18px] desktop:grid-cols-2 desktop:gap-[18px]'
            : 'mt-4 desktop:mt-[18px]'
        }
      >
        <ComputerLeaseCard computer={computer} />
        {computer.allocation && <ComputerPoolCard computer={computer} onChanged={onChanged} />}
      </div>

      <div className="mt-4 desktop:mt-[18px]">
        <ComputerAgentAccessCard computer={computer} onSaved={onChanged} />
      </div>

      <div className="mt-4 desktop:mt-[18px]">
        <ComputerPolicyCard computer={computer} onSaved={onChanged} />
      </div>

      {computer.canEditPolicy && (
        <div className="mt-4 desktop:mt-[18px]">
          <ComputerActivityCard computer={computer} />
        </div>
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
              () => router.push(orgPath('/computers'))
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

function Meta({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[6px] font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
      <Icon name={icon} size={14} color="var(--text-tertiary)" />
      {children}
    </span>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row grid-cols-[auto_1fr] gap-3">
      <span className="font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">{label}</span>
      <span className="min-w-0 text-right font-sans text-[12.5px] font-medium leading-normal">{children}</span>
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

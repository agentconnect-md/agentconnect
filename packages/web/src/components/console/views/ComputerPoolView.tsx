'use client'

// The managed computer pool's page (computer-use.md §10): every managed computer, which Infra shows as one entry.
import { useEffect, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { status } from '@/lib/data'
import { featureFlagEnabled } from '@/lib/feature-flags'
import { useComputerPool, useComputers } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { useModal } from '@/components/console/ModalProvider'
import { NotFound } from '@/components/console/NotFound'
import { useCrumbSlot } from '@/components/console/Shell'
import { ComputerRow, poolCounts, useComputerPoolTitle } from '@/components/console/ComputersSection'
import { FLEET_GRID } from '@/components/console/fleet-grid'
import { KubernetesMark, LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

export default function ComputerPoolView() {
  const t = useTranslations('Computers')
  const { orgPath } = useOrgs()
  const offered = featureFlagEnabled('computer-use')
  const { data, error, isLoading } = useComputers()
  const { data: pool } = useComputerPool()
  const { openModal } = useModal()
  const title = useComputerPoolTitle()
  const { register: registerCrumb } = useCrumbSlot()
  useEffect(() => {
    registerCrumb({ id: 'pool', title, status: '', statusLabel: '' })
    return () => registerCrumb(null)
  }, [registerCrumb, title])
  const managed = useMemo(() => (data ?? []).filter((c) => c.kind === 'managed'), [data])

  if (!offered || (pool && !pool.enabled && managed.length === 0 && !isLoading)) {
    return (
      <div className="wrap px-4 pt-[14px] desktop:p-0">
        <NotFound
          icon="monitor-off"
          kind="COMPUTER POOL"
          title={t('poolPage.notFound')}
          actionLabel={t('detail.back')}
          actionHref={orgPath('/daemons#computers')}
        />
      </div>
    )
  }

  const managedInstall = featureFlagEnabled('managed')
  const available = pool?.available === true
  const s = status(available ? 'online' : 'offline')
  const { running, asleep } = poolCounts(managed)

  return (
    <div className="wrap max-w-[1240px] px-4 pt-[14px] pb-1 desktop:p-0">
      <div className="mb-5 flex items-start gap-4">
        <span
          className={`relative flex h-13 w-13 flex-none items-center justify-center rounded-lg ${
            managedInstall ? 'bg-(--brand-soft)' : 'border border-(--border-subtle) bg-(--surface-sunken)'
          }`}
        >
          {managedInstall ? (
            <Icon name="cloud" size={26} color={available ? 'var(--brand)' : 'var(--text-tertiary)'} />
          ) : (
            <span className="flex h-[26px] w-[26px]">
              <KubernetesMark />
            </span>
          )}
          <span
            className="dot absolute -right-1 -bottom-1 h-[14px] w-[14px] border-[2.5px] border-(--surface-app)"
            style={{ background: s.dot }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-[10px]">
            <h1 className="ptitle">{title}</h1>
            <span className="badge" style={{ background: s.bg, color: s.text }}>
              <span className="dot h-[6px] w-[6px]" style={{ background: s.dot }} />
              {available ? t('poolEntry.available') : t('poolEntry.unavailable')}
            </span>
          </div>
          <p className="psub mt-2 mb-0">
            {managed.length === 0 ? t('poolEntry.none') : t('poolEntry.meta', { running, asleep })}
            {' · '}
            {t('poolPage.description')}
          </p>
        </div>
        {pool?.enabled && (
          <Button size="sm" onClick={() => openModal('computer', undefined, { computerSource: 'pool' })}>
            <Icon name="plus" size={15} />
            {t('poolPage.add')}
          </Button>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
        >
          {t('loadError', { message: error instanceof Error ? error.message : String(error) })}
        </div>
      )}
      {isLoading && managed.length === 0 ? (
        <LoadingState fill />
      ) : managed.length === 0 ? (
        <div className="card px-4 py-[18px] font-sans text-[12.5px] font-normal leading-[1.6] text-(--text-secondary)">
          {t('poolPage.empty')}
        </div>
      ) : (
        <div className={FLEET_GRID}>
          {managed.map((c) => (
            <ComputerRow key={c.id} computer={c} />
          ))}
        </div>
      )}
    </div>
  )
}

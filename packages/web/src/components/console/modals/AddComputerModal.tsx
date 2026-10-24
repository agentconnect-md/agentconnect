// No 'use client' here: rendered only by ModalProvider (the client boundary).

// Add Computer (computer-use.md §3.6): mint a one-time registration token and wait for the desktop to come online.
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  ApiError,
  createComputerRegistration,
  fetchComputer,
  fetchComputerRegistration,
  type ComputerDto,
  type ComputerRegistrationDto
} from '@/lib/api'
import { computerInstallCommand, type InstallOs, useAgo, useComputerPool } from '@/lib/computers'
import { useOrgs } from '@/lib/org-context'
import { Spinner } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import AddPoolComputer from '@/components/console/modals/AddPoolComputer'

/** How often the dialog asks whether the desktop has registered and connected. */
export const REGISTRATION_POLL_MS = 3000

const OSES: InstallOs[] = ['linux', 'macos', 'windows', 'docker']

export default function AddComputerModal({
  onClose,
  source: initialSource = 'own'
}: {
  onClose: () => void
  source?: 'own' | 'pool'
}) {
  const t = useTranslations('Computers.add')
  const tc = useTranslations('Computers')
  const ago = useAgo()
  const router = useRouter()
  const { orgPath } = useOrgs()
  const [os, setOs] = useState<InstallOs>('linux')
  const [name, setName] = useState('')
  const [minting, setMinting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [registration, setRegistration] = useState<ComputerRegistrationDto | null>(null)
  const [computerId, setComputerId] = useState<string | null>(null)
  const [computer, setComputer] = useState<ComputerDto | null>(null)
  const [copied, setCopied] = useState(false)
  const [expired, setExpired] = useState(false)
  const connected = computer !== null && computer.status !== 'offline' && computer.status !== 'revoked'
  const { data: pool } = useComputerPool()
  const [source, setSource] = useState<'own' | 'pool'>(initialSource)

  // Wait for the token to be spent, then for the new Computer's channel to report in.
  useEffect(() => {
    if (!registration || connected || expired) return
    let active = true
    const tick = async () => {
      try {
        if (!computerId) {
          const status = await fetchComputerRegistration(registration.registrationId)
          if (!active) return
          if (status.computerId) setComputerId(status.computerId)
          else if (Date.now() > Date.parse(registration.expiresAt)) setExpired(true)
          return
        }
        const row = await fetchComputer(computerId)
        if (active) setComputer(row)
      } catch (cause) {
        // A reaped registration reads 404; any other failure is retried on the next tick.
        if (active && !computerId && cause instanceof ApiError && cause.status === 404) setExpired(true)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), REGISTRATION_POLL_MS)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [registration, computerId, connected, expired])

  const restart = () => {
    setRegistration(null)
    setExpired(false)
    setCopied(false)
  }

  const mint = async () => {
    if (minting) return
    setMinting(true)
    setErr(null)
    try {
      const trimmed = name.trim()
      setRegistration(await createComputerRegistration(trimmed ? { name: trimmed } : {}))
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMinting(false)
    }
  }

  const command = registration ? computerInstallCommand(os, registration) : null
  const copy = async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (insecure context); the text stays selectable */
    }
  }

  // A deployment that runs the pool offers a managed computer too (computer-use.md §15.1); a minted command stays put.
  const sourcePicker =
    pool?.enabled && !registration ? (
      <div className="fld mb-[14px]">
        <span className="fldlbl">{t('source')}</span>
        <div role="radiogroup" aria-label={t('source')} className="pillbar self-start">
          {(['own', 'pool'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={source === value}
              onClick={() => setSource(value)}
              className={source === value ? 'pill on' : 'pill'}
            >
              {t(value)}
            </button>
          ))}
        </div>
      </div>
    ) : null
  if (source === 'pool' && sourcePicker)
    return <AddPoolComputer onClose={onClose} available={pool?.available === true} sourcePicker={sourcePicker} />

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="monitor" size={17} color="var(--brand)" />
        </span>
        <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
      </div>
      <div className="modalbody">
        {sourcePicker}
        <p className="mb-[14px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
          {os === 'docker' ? t('descriptionDocker') : t('description')}
        </p>
        <div className="fld">
          <span className="fldlbl">{t('os')}</span>
          <div role="radiogroup" aria-label={t('os')} className="pillbar self-start">
            {OSES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={os === value}
                onClick={() => setOs(value)}
                className={os === value ? 'pill on' : 'pill'}
              >
                {value === 'docker' ? t('docker') : tc(`os.${value}`)}
              </button>
            ))}
          </div>
          <span className="mt-[6px] block font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t(`osHint.${os}`)}
          </span>
        </div>
        {!registration && (
          <div className="fld mt-[14px]">
            <span className="fldlbl">
              {t('name')} <span className="font-normal text-(--text-tertiary)">· {t('optional')}</span>
            </span>
            <input
              className="inp"
              value={name}
              maxLength={120}
              spellCheck={false}
              placeholder={t('namePlaceholder')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void mint()
              }}
            />
          </div>
        )}
        {registration && command && (
          <>
            <p className="mt-[14px] mb-[8px] font-sans text-[12px] font-semibold leading-normal text-(--text-tertiary)">
              {os === 'docker' ? t('runDocker') : t('run')}
            </p>
            <div className="overflow-hidden rounded-[9px] border border-(--gray-800) bg-(--gray-1000)">
              <div className="flex items-center border-b border-(--gray-800)">
                <span className="inline-flex items-center gap-[6px] px-[13px] py-[9px] font-mono text-[11px] font-medium leading-normal text-[#cdd6e0]">
                  <Icon name="terminal" size={13} />
                  {os === 'windows' ? t('shell.windows') : t('shell.posix')}
                </span>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="ml-auto inline-flex cursor-pointer items-center gap-[5px] border-0 bg-transparent px-[13px] py-[9px] font-mono text-[11px] font-medium leading-normal text-(--text-inverse-dim)"
                >
                  <Icon name={copied ? 'check' : 'copy'} size={12} />
                  {copied ? t('copied') : t('copy')}
                </button>
              </div>
              <div
                data-install-command
                className="break-all px-[14px] py-[13px] font-mono text-[12px] leading-[1.7] text-[#cdd6e0]"
              >
                <span className="text-(--magenta-300)">{os === 'windows' ? '>' : '$'}</span> {command}
              </div>
            </div>
            {!expired && (
              <p className="mt-[8px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                {t('expires', { when: ago(registration.expiresAt) })}
              </p>
            )}
            <div className="mt-[14px] flex items-center gap-[11px] rounded-[9px] border border-dashed border-(--border-strong) px-[14px] py-[13px]">
              {expired ? (
                <>
                  <span className="flex h-[22px] w-[22px] flex-none items-center justify-center leading-[0]">
                    <Icon name="triangle-alert" size={18} color="var(--status-paused)" />
                  </span>
                  <div className="flex-1">
                    <div className="font-sans text-[13px] font-semibold leading-normal">{t('expired')}</div>
                    <div className="mono text-[11px] text-(--text-tertiary)">{t('expiredHint')}</div>
                  </div>
                </>
              ) : connected ? (
                <>
                  <span className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full bg-(--status-online)">
                    <Icon name="check" size={13} color="#fff" />
                  </span>
                  <div className="flex-1">
                    <div className="font-sans text-[13px] font-semibold leading-normal">{t('connected')}</div>
                    <div className="mono text-[11px] text-(--text-tertiary)">{computer?.name}</div>
                  </div>
                </>
              ) : (
                <>
                  <span className="flex-none leading-[0]">
                    <Spinner size={22} />
                  </span>
                  <div className="flex-1">
                    <div className="font-sans text-[13px] font-semibold leading-normal">
                      {computerId ? t('registered') : t('waiting')}
                    </div>
                    <div className="mono text-[11px] text-(--text-tertiary)">
                      {computerId ? t('registeredHint') : t('waitingHint')}
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
        {err && (
          <div
            role="alert"
            className="mt-[14px] flex items-start gap-2 rounded-md border border-(--status-error) bg-(--status-error-soft) px-3 py-[11px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)"
          >
            <Icon name="triangle-alert" size={15} />
            {t('mintError', { message: err })}
          </div>
        )}
      </div>
      <div className="modalfoot">
        <span className="mono text-[11px] text-(--text-tertiary)">{registration ? t('shownOnce') : ''}</span>
        <div className="flex-1" />
        {!registration ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button variant="primary" disabled={minting} onClick={() => void mint()}>
              {minting ? t('minting') : t('create')}
            </Button>
          </>
        ) : expired ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button variant="primary" onClick={restart}>
              {t('createNew')}
            </Button>
          </>
        ) : connected && computer ? (
          <Button
            variant="primary"
            onClick={() => {
              onClose()
              router.push(orgPath(`/computers/${computer.id}`))
            }}
          >
            {t('open')}
          </Button>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            {t('close')}
          </Button>
        )}
      </div>
    </>
  )
}

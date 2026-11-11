// No 'use client' here: rendered only inside ModalProvider's tree and the Settings view, both client trees.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { QRCodeSVG } from 'qrcode.react'
import { Button, Icon } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { weChatApi, type WeChatLoginDto } from './api'

// A failed poll that is not a refusal (network, 5xx) retries after this pause rather than ending the login.
export const WECHAT_POLL_RETRY_MS = 2000

// The least time between two polls, so an answer that comes back at once never turns into a tight loop.
export const WECHAT_POLL_MIN_INTERVAL_MS = 1000

type FailureKey = 'failed.expired' | 'failed.verifyCodeBlocked' | 'failed.agentUnavailable' | 'failed.setupFailed'

const FAILURES: Record<NonNullable<WeChatLoginDto['failureReason']>, FailureKey> = {
  expired: 'failed.expired',
  verify_code_blocked: 'failed.verifyCodeBlocked',
  agent_unavailable: 'failed.agentUnavailable',
  setup_failed: 'failed.setupFailed'
}

export type WeChatLoginPhase = 'idle' | 'active' | 'expired' | 'completed' | 'failed'

export interface WeChatLogin {
  phase: WeChatLoginPhase
  login: WeChatLoginDto | null
  starting: boolean
  reconciling: boolean
  sendingCode: boolean
  codeRejected: boolean
  // A refusal of the poll itself (404 gone, 403), shown in place of a failure reason.
  pollError: string | null
  // Milliseconds left on the code shown, while nobody has scanned it.
  remainingMs: number | null
  // The last code shown, kept so an expired one can be drawn behind its refresh button.
  lastQrUrl: string | null
  start(): Promise<string | null>
  submitCode(code: string): void
}

/** Runs one CP QR login: start it, long-poll it back-to-back, send a verification number, abort on unmount. */
export function useWeChatLogin(input: {
  agentId: string
  botId?: string
  onCompleted(login: WeChatLoginDto): void
}): WeChatLogin {
  const { agentId, botId } = input
  const [login, setLogin] = useState<WeChatLoginDto | null>(null)
  const [poll, setPoll] = useState<{ id: string; n: number; verifyCode?: string } | null>(null)
  const [starting, setStarting] = useState(false)
  const [codeRejected, setCodeRejected] = useState(false)
  const [pollError, setPollError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [lastQrUrl, setLastQrUrl] = useState<string | null>(null)
  const busy = useRef(false)
  const onCompleted = useRef(input.onCompleted)
  onCompleted.current = input.onCompleted
  const waiting = login?.status === 'waiting'
  const remainingMs = waiting ? Math.max(0, Date.parse(login.expiresAt) - now) : null
  const timedOut = remainingMs === 0

  if (login?.qrUrl && login.qrUrl !== lastQrUrl) setLastQrUrl(login.qrUrl)

  // The countdown ticks only while an unscanned code is on screen.
  useEffect(() => {
    if (!waiting) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [waiting])

  useEffect(() => {
    if (!poll) return
    const ctrl = new AbortController()
    const began = Date.now()
    let retry: ReturnType<typeof setTimeout> | undefined
    weChatApi
      .getLogin(poll.id, { ...(poll.verifyCode ? { verifyCode: poll.verifyCode } : {}), signal: ctrl.signal })
      .then(
        (next) => {
          if (ctrl.signal.aborted) return
          setLogin(next)
          setCodeRejected(poll.verifyCode !== undefined && next.status === 'verify_code')
          // A verification prompt waits for the member's number; an unscanned code past its deadline waits for a refresh.
          const expired = next.status === 'waiting' && Date.parse(next.expiresAt) <= Date.now()
          if ((next.status === 'waiting' && !expired) || next.status === 'scanned') {
            const pause = Math.max(0, WECHAT_POLL_MIN_INTERVAL_MS - (Date.now() - began))
            retry = setTimeout(() => setPoll({ id: poll.id, n: poll.n + 1 }), pause)
          } else setPoll(null)
          if (next.status === 'completed') onCompleted.current(next)
        },
        (error: unknown) => {
          if (ctrl.signal.aborted) return
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            setPollError(error.status === 404 ? '' : error.message)
            setPoll(null)
            return
          }
          retry = setTimeout(() => setPoll({ ...poll, n: poll.n + 1 }), WECHAT_POLL_RETRY_MS)
        }
      )
    return () => {
      ctrl.abort()
      clearTimeout(retry)
    }
  }, [poll])

  async function start(): Promise<string | null> {
    if (busy.current || poll) return null
    busy.current = true
    setStarting(true)
    setPollError(null)
    setCodeRejected(false)
    try {
      const started = await weChatApi.startLogin({ agentId, ...(botId ? { botId } : {}) })
      setNow(Date.now())
      setLogin(started)
      setPoll(started.status === 'waiting' || started.status === 'scanned' ? { id: started.id, n: 0 } : null)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    } finally {
      busy.current = false
      setStarting(false)
    }
  }

  function submitCode(code: string) {
    if (!login || login.status !== 'verify_code' || poll) return
    setPoll({ id: login.id, n: 0, verifyCode: code })
  }

  const phase: WeChatLoginPhase =
    timedOut || (pollError === null && login?.status === 'failed' && login.failureReason === 'expired')
      ? 'expired'
      : pollError !== null || login?.status === 'failed'
        ? 'failed'
        : login?.status === 'completed'
          ? 'completed'
          : login
            ? 'active'
            : 'idle'
  return {
    phase,
    login,
    starting,
    reconciling: timedOut && poll !== null,
    sendingCode: poll?.verifyCode !== undefined,
    codeRejected,
    pollError,
    remainingMs,
    lastQrUrl,
    start,
    submitCode
  }
}

/** The login's live state: the QR code, the scanned prompt, the verification number, the result, or the failure. */
export function WeChatLoginView({
  state,
  onRetry,
  onDone
}: {
  state: WeChatLogin
  onRetry(): void
  // Shown once connected, where the wizard has no footer of its own to close it.
  onDone?(): void
}) {
  const t = useTranslations('Platforms.wechat')
  const [code, setCode] = useState('')
  const { login, phase } = state
  const codeTrim = code.trim()
  const codeOk = /^\d+$/.test(codeTrim)

  if (phase === 'expired') {
    return (
      <div className="flex flex-col items-center gap-3 desktop:flex-row desktop:items-start">
        <div className="relative flex h-[184px] w-[184px] flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-white p-2">
          {state.lastQrUrl && (
            <QRCodeSVG value={state.lastQrUrl} size={166} aria-hidden className="opacity-15 blur-[2px]" />
          )}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span className="font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
              {t('qr.expired')}
            </span>
            <Button size="sm" disabled={state.starting || state.reconciling} onClick={onRetry}>
              <Icon name="refresh-cw" size={13} />
              {state.starting ? t('starting') : t('qr.refreshCode')}
            </Button>
          </div>
        </div>
        <div className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('qr.expiredHint')}
        </div>
      </div>
    )
  }
  if (phase === 'failed') {
    const reason = login?.failureReason ? t(FAILURES[login.failureReason]) : null
    return (
      <div role="alert" className="flex flex-col items-start gap-2">
        <Line icon="circle-alert" color="var(--status-error)">
          {reason ?? (state.pollError || t('failed.gone'))}
        </Line>
        <Button size="sm" variant="secondary" disabled={state.starting || state.reconciling} onClick={onRetry}>
          {state.starting ? t('starting') : t('retry')}
        </Button>
      </div>
    )
  }
  if (!login || phase === 'idle') return null
  if (phase === 'completed') {
    return (
      <div role="status" className="flex flex-col gap-1">
        <Line icon="circle-check" color="var(--status-online)">
          {t('completed.title', { tail: login.wechatUserTail ?? '' })}
        </Line>
        <p className="m-0 pl-[22px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('completed.body')}
        </p>
        {onDone && (
          <div className="pl-[22px] pt-1">
            <Button size="sm" onClick={onDone}>
              {t('footer.done')}
            </Button>
          </div>
        )}
      </div>
    )
  }
  if (login.status === 'scanned') {
    return (
      <div role="status" className="flex flex-col gap-1">
        <Line icon="smartphone" color="var(--brand)">
          {t('scanned.title')}
        </Line>
        <p className="m-0 pl-[22px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {t('scanned.body')}
        </p>
      </div>
    )
  }
  if (login.status === 'verify_code') {
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (codeOk && !state.sendingCode) state.submitCode(codeTrim)
        }}
      >
        <p className="m-0 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          {t('verify.body')}
        </p>
        <div className="flex items-end gap-2">
          <label className="fld w-40">
            <span className="fldlbl">{t('verify.label')}</span>
            <input
              className={`inp mn ${state.codeRejected ? 'border-(--status-error)' : ''}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              disabled={state.sendingCode}
            />
          </label>
          <Button size="sm" type="submit" disabled={!codeOk || state.sendingCode}>
            {state.sendingCode ? t('verify.sending') : t('verify.submit')}
          </Button>
        </div>
        {state.codeRejected && (
          <p className="m-0 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">
            {t('verify.rejected')}
          </p>
        )}
      </form>
    )
  }
  return (
    <div className="flex flex-col items-center gap-3 desktop:flex-row desktop:items-start">
      <div className="flex h-[184px] w-[184px] flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-white p-2">
        {login.qrUrl ? (
          <QRCodeSVG value={login.qrUrl} size={166} role="img" aria-label={t('qr.alt')} />
        ) : (
          <Icon name="loader" size={18} color="var(--text-tertiary)" className="animate-spin" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">{t('qr.scan')}</div>
        {state.remainingMs !== null && (
          <div role="timer" className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('qr.expiresIn', { time: clock(state.remainingMs) })}
          </div>
        )}
        {login.qrUrl && (
          <a
            href={login.qrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="lnk inline-flex items-center gap-[5px] text-[12px]"
          >
            {t('qr.openOnPhone')}
            <Icon name="external-link" size={12} />
          </a>
        )}
      </div>
    </div>
  )
}

function Line({ icon, color, children }: { icon: string; color: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 font-sans text-[12.5px] font-medium leading-[1.5] text-(--text-secondary)">
      <Icon name={icon} size={14} color={color} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

// m:ss, rounded up so the code reads 0:00 only once it has expired.
function clock(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardHost, WebWizardTransport } from '../contract'
import { usePublishedFooter, usePublishedRegionLock } from '../publish'
import { BotSetupWalkthrough, DeliveryLine } from '../wizard-chrome'
import { feishuApi, type FeishuRegion } from './api'
import { feishuWalkthroughSteps } from './steps'

/** This platform's delivery vocabulary — {@link WebTransportAffordance.labels}.
 *  Message keys, not copy: the Body resolves them for its own delivery line. */
export const FEISHU_TRANSPORT_LABEL: Record<WebWizardTransport, string> = {
  socket: 'Platforms.feishu.transport.socket',
  http: 'Platforms.feishu.transport.http'
}

/** A registration failure key on the pane's own namespace, with the fallback. */
type FeishuRegistrationKey =
  Parameters<ReturnType<typeof useTranslations<'Platforms.feishu'>>>[0] | 'registration.setupFailed'

// Failures the CP can report for a registration. Keys, not copy — the poll below
// resolves them, and an unknown reason falls back to `setupFailed`.
const FEISHU_REGISTRATION_FAILURES: Record<string, FeishuRegistrationKey> = {
  denied: 'registration.denied',
  expired: 'registration.expired',
  agent_unavailable: 'registration.agentUnavailable',
  invalid_credentials: 'registration.invalidCredentials',
  org_mismatch: 'registration.orgMismatch',
  setup_failed: 'registration.setupFailed'
}

/**
 * Lark/Feishu's pane. It defaults to the official device-registration deeplink —
 * the App Secret never reaches the browser, so that flow commits out of band and
 * the pane suppresses the host footer entirely while it owns the action. The
 * manual credential pair stays available as the advanced fallback, and the setup
 * checklist rides along in reuse mode too because a reused bot's app needs the
 * same app-level settings.
 */
export function FeishuWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.feishu')
  // §5 `regions` vocabulary: the host owns the pick (its switcher lives on the
  // picker tile); legacy/unset reads as the international Lark cloud.
  const region: FeishuRegion = host.region === 'feishu' ? 'feishu' : 'lark'
  const brand = region === 'lark' ? 'Lark' : 'Feishu'

  const [appName, setAppName] = useState(agent.name)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [verificationToken, setVerificationToken] = useState('')
  const [encryptKey, setEncryptKey] = useState('')
  const [method, setMethod] = useState<'deeplink' | 'manual'>('deeplink')
  const [phase, setPhase] = useState<'idle' | 'authorizing'>('idle')
  const [registration, setRegistration] = useState<{
    id: string
    authorizationUrl: string
    expiresAt: string
    transport: WebWizardTransport
  } | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  // Synchronous re-entry guard — `saving` only commits on the next render, so a
  // double-click would otherwise open two authorization tabs.
  const busyRef = useRef(false)

  const appIdTrim = appId.trim()
  const appIdOk = appIdTrim.startsWith('cli_') && appIdTrim.length >= 8
  const secretOk = appSecret.trim().length >= 8
  const verificationOk = verificationToken.trim().length > 0
  const transport = host.transport
  const valid = appIdOk && secretOk && (transport === 'socket' || verificationOk)
  const callbackUrl = host.relayCapability.publicUrl
    ? `${host.relayCapability.publicUrl.replace(/\/+$/, '')}/feishu/events`
    : null
  // The checklist's delivery arm follows what will actually carry events: the
  // reused bot's own transport in reuse mode, the chosen one when creating.
  const checklistTransport: WebWizardTransport =
    host.mode === 'existing' ? (host.selectedBot?.transport ?? 'socket') : transport
  const isDeeplink = host.mode === 'create' && method === 'deeplink'

  // Feishu needs a few app-level settings beyond the credentials that aren't obvious
  // and each fails silently if missed — surfaced as a transport-aware checklist.
  // Resolved per render so the list follows the console language.
  const commonReqs: { icon: string; title: string; desc: string }[] = [
    { icon: 'building-complex', title: t('checklist.sameOrg.title'), desc: t('checklist.sameOrg.desc') },
    { icon: 'bot', title: t('checklist.botCapability.title'), desc: t('checklist.botCapability.desc') },
    { icon: 'shield-check', title: t('checklist.scopes.title'), desc: t('checklist.scopes.desc') },
    { icon: 'users', title: t('checklist.inviteBot.title'), desc: t('checklist.inviteBot.desc') }
  ]
  const deliveryReqs: Record<WebWizardTransport, { icon: string; title: string; desc: string }[]> = {
    socket: [{ icon: 'radio', title: t('checklist.longConnection.title'), desc: t('checklist.longConnection.desc') }],
    http: [{ icon: 'radio', title: t('checklist.httpCallbacks.title'), desc: t('checklist.httpCallbacks.desc') }]
  }

  const submit = async () => {
    setShowErrors(true)
    if (busyRef.current || !valid) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      await host.createIntegration({
        platform: 'feishu',
        agentId: agent.id,
        transport,
        feishu: {
          appId: appIdTrim,
          appSecret: appSecret.trim(),
          region,
          ...(transport === 'http'
            ? {
                verificationToken: verificationToken.trim(),
                ...(encryptKey.trim() ? { encryptKey: encryptKey.trim() } : {})
              }
            : {})
        }
      })
      host.close()
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  // Lark/Feishu's official device flow returns a normal authorization deeplink.
  // Open a blank tab synchronously so popup blockers preserve the user's click
  // while the CP asks the provider for that URL.
  const startAuto = async () => {
    if (busyRef.current || registration) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    const authorizationTab = window.open('about:blank', '_blank')
    if (authorizationTab) authorizationTab.opener = null
    try {
      const started = await feishuApi.startRegistration({
        agentId: agent.id,
        region,
        transport,
        ...(appName.trim() ? { name: appName.trim() } : {})
      })
      setRegistration(started)
      setPhase('authorizing')
      if (authorizationTab) authorizationTab.location.replace(started.authorizationUrl)
      else window.open(started.authorizationUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      authorizationTab?.close()
      host.setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // The App Secret never reaches the browser. Poll only the short-lived session:
  // once the CP has installed the credentials and pushed the integration, refresh
  // the two console projections and close.
  const { close, invalidate, setError } = host
  const polling = host.mode === 'create' && method === 'deeplink' && phase === 'authorizing' && registration !== null
  const registrationId = registration?.id ?? null
  useEffect(() => {
    if (!polling || !registrationId) return
    let alive = true
    const stop = (message: string) => {
      setPhase('idle')
      setRegistration(null)
      setError(message)
    }
    const tick = async () => {
      try {
        const status = await feishuApi.getRegistration(registrationId)
        if (!alive || status.status === 'pending') return
        if (status.status === 'completed') {
          invalidate()
          return close()
        }
        stop(t(FEISHU_REGISTRATION_FAILURES[status.failureReason ?? ''] ?? 'registration.setupFailed'))
      } catch (e) {
        // A missing short-lived session is terminal; ordinary network failures
        // remain retryable and the next poll keeps the setup moving.
        if (alive && e instanceof ApiError && e.status === 404) stop(t('registration.expired'))
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [close, invalidate, polling, registrationId, setError, t])

  usePublishedFooter(host, {
    label: saving ? t('footer.connecting') : t('footer.connect'),
    enabled: valid && !saving,
    onSubmit: () => void submit(),
    // The deeplink flow's commit is its own inline "Create … bot" button and the
    // CP finishes out of band, so the shared primary would be a dead control.
    hidden: isDeeplink
  })
  // A started registration is bound to the cloud it was minted for. Switching
  // region now would relabel that still-pending authorization (and its poll) as
  // the other cloud, so the host's switcher is held until this flow ends.
  usePublishedRegionLock(host, phase === 'authorizing')

  return (
    <>
      {host.mode === 'create' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-[6px]">
            <div className="inline-flex flex-none rounded-lg border border-(--border-default) bg-(--surface-card) p-[3px]">
              {(['deeplink', 'manual'] as const).map((candidate) => {
                const on = method === candidate
                return (
                  <button
                    key={candidate}
                    type="button"
                    disabled={phase === 'authorizing'}
                    onClick={() => {
                      setMethod(candidate)
                      setShowErrors(false)
                      host.setError(null)
                    }}
                    title={phase === 'authorizing' ? t('method.locked') : undefined}
                    className={`rounded-[6px] px-[11px] py-[5px] font-sans text-[12px] font-semibold leading-normal ${
                      on ? 'bg-(--brand-soft) text-(--brand)' : 'bg-transparent text-(--text-tertiary)'
                    } ${phase === 'authorizing' ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    {candidate === 'deeplink' ? t('method.deeplink') : t('method.manual')}
                  </button>
                )
              })}
            </div>
            <span className="min-w-0 flex-1 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              {method === 'deeplink' ? t('method.deeplinkHint', { brand }) : t('method.manualHint')}
            </span>
          </div>
          <div className="mb-3 flex justify-end">
            <DeliveryLine
              labels={{ socket: t('transport.socket'), http: t('transport.http') }}
              transport={registration?.transport ?? transport}
              relayAvailable={host.relayCapability.available}
              locked={phase === 'authorizing'}
              onSwitch={host.setTransport}
            />
          </div>
          <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
            {method === 'deeplink' ? (
              phase === 'authorizing' && registration ? (
                <div className="flex gap-[10px]">
                  <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--brand-soft)">
                    <Icon name="loader" size={12} color="var(--brand)" className="animate-spin" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                      {t('deeplink.approveTitle', { brand })}
                    </div>
                    <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                      {t('deeplink.approveBody')}
                    </div>
                    <a
                      href={registration.authorizationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="lnk mt-2 inline-flex items-center gap-[5px]"
                    >
                      {t('deeplink.reopen', { brand })}
                      <Icon name="external-link" size={12} />
                    </a>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                    {t('deeplink.nameTitle')}
                  </div>
                  <div className="flex flex-col gap-2 desktop:flex-row">
                    <div className="fld flex-1">
                      <input
                        className="inp mn"
                        placeholder={t('deeplink.botNamePlaceholder')}
                        value={appName}
                        onChange={(e) => setAppName(e.target.value)}
                      />
                    </div>
                    <Button
                      disabled={saving}
                      onClick={() => void startAuto()}
                      className={saving ? 'flex-none cursor-default opacity-50' : 'flex-none'}
                    >
                      <span className="imark h-4 w-4 border-0 bg-transparent">
                        <PlatformMark platform="feishu" />
                      </span>
                      {saving ? t('deeplink.creating') : t('deeplink.create', { brand })}
                    </Button>
                  </div>
                </>
              )
            ) : (
              <>
                <div className="mb-3 flex gap-[10px]">
                  <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                    1
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">
                      {t('manual.step1', { brand })}
                    </div>
                    <div className="group relative">
                      <a
                        href={
                          region === 'lark'
                            ? 'https://open.larksuite.com/page/launcher'
                            : 'https://open.feishu.cn/page/launcher'
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                      >
                        <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                          <PlatformMark platform="feishu" />
                        </span>
                        {t('deeplink.create', { brand })}
                        <Icon name="external-link" size={14} />
                      </a>
                      <BotSetupWalkthrough
                        steps={feishuWalkthroughSteps(
                          t,
                          region === 'lark' ? 'Lark' : 'Feishu',
                          region === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'
                        )}
                        label={t('walkthroughLabel', { brand })}
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                  <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                    2
                  </span>
                  <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                    {t('manual.step2')}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
                  <div className="fld">
                    <span className="fldlbl">{t('manual.appId')}</span>
                    <input
                      className={`inp mn ${showErrors && !appIdOk ? 'border-(--status-error)' : ''}`}
                      placeholder={t('manual.appIdPlaceholder')}
                      value={appId}
                      onChange={(e) => setAppId(e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <span className="fldlbl">{t('manual.appSecret')}</span>
                    <input
                      className={`inp mn ${showErrors && !secretOk ? 'border-(--status-error)' : ''}`}
                      placeholder={t('manual.appSecretPlaceholder')}
                      value={appSecret}
                      onChange={(e) => setAppSecret(e.target.value)}
                    />
                  </div>
                </div>
                {transport === 'http' && (
                  <div className="mt-[14px] border-t border-dashed border-(--border-default) pt-[13px]">
                    <div className="mb-[11px] flex items-center gap-[10px]">
                      <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                        3
                      </span>
                      <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                        {t('manual.step3')}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
                      <div className="fld">
                        <span className="fldlbl">{t('manual.verificationToken')}</span>
                        <input
                          className={`inp mn ${showErrors && !verificationOk ? 'border-(--status-error)' : ''}`}
                          placeholder={t('manual.fromEventSubscriptions')}
                          value={verificationToken}
                          onChange={(e) => setVerificationToken(e.target.value)}
                        />
                      </div>
                      <div className="fld">
                        <span className="fldlbl">
                          {t('manual.encryptKey')}{' '}
                          <span className="font-normal text-(--text-tertiary)">{t('manual.optional')}</span>
                        </span>
                        <input
                          className="inp mn"
                          placeholder={t('manual.fromEventSubscriptions')}
                          value={encryptKey}
                          onChange={(e) => setEncryptKey(e.target.value)}
                        />
                      </div>
                    </div>
                    {callbackUrl && (
                      <div className="mt-[10px] pl-[30px]">
                        <div className="fld">
                          <span className="fldlbl">{t('manual.requestUrl')}</span>
                          <input
                            className="inp mn"
                            readOnly
                            value={callbackUrl}
                            onFocus={(e) => e.currentTarget.select()}
                          />
                        </div>
                        <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                          {t('manual.requestUrlHint', { brand })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      {(host.mode === 'existing' || method === 'manual') && (
        <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
          <div className="mb-[11px] flex items-center gap-2 font-sans text-[12.5px] font-semibold leading-normal text-(--text-secondary)">
            <Icon name="shield-check" size={14} color="var(--brand)" className="flex-none" />
            {t('checklistTitle', { brand })}
          </div>
          <ul className="flex flex-col gap-[10px]">
            {[...commonReqs.slice(0, 1), ...deliveryReqs[checklistTransport], ...commonReqs.slice(1)].map((r) => (
              <li key={r.title} className="flex items-start gap-2">
                <Icon name={r.icon} size={14} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
                <span className="font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  <span className="font-medium text-(--text-secondary)">{r.title}</span> — {r.desc}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

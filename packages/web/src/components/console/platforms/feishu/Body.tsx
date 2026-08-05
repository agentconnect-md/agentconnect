// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useRef, useState } from 'react'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ApiError } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardHost, WebWizardTransport } from '../contract'
import { usePublishedFooter, usePublishedRegionLock } from '../publish'
import { BotSetupWalkthrough, DeliveryLine } from '../wizard-chrome'
import { feishuApi, type FeishuRegion } from './api'
import { feishuWalkthroughSteps } from './steps'

/** This platform's delivery vocabulary — {@link WebTransportAffordance.labels}. */
export const FEISHU_TRANSPORT_LABEL: Record<WebWizardTransport, string> = {
  socket: 'Long connection',
  http: 'HTTP callbacks'
}

const FEISHU_REGISTRATION_FAILURES: Record<string, string> = {
  denied: 'The Lark/Feishu app setup was cancelled.',
  expired: 'This setup link expired — start again.',
  agent_unavailable: 'This agent moved or was removed during setup. Check its daemon, then try again.',
  invalid_credentials: 'The app was created, but its credentials could not be verified.',
  org_mismatch:
    'This app belongs to a different Lark/Feishu organization from this AgentConnect deployment. Create it in the same organization and try again.',
  setup_failed: 'Lark/Feishu could not complete the app setup. Please try again.'
}

// Feishu needs a few app-level settings beyond the credentials that aren't obvious
// and each fails silently if missed — surfaced as a transport-aware checklist.
const FEISHU_COMMON_REQS: { icon: string; title: string; desc: string }[] = [
  {
    icon: 'building-2',
    title: 'Use the same organization',
    desc: 'Create every Bot App in the same Lark/Feishu organization as the App used to sign in to AgentConnect.'
  },
  {
    icon: 'bot',
    title: 'Enable the bot capability',
    desc: 'In the app’s “Add features”, turn on Bot — otherwise it can’t send or receive messages.'
  },
  {
    icon: 'shield-check',
    title: 'Grant message, contact and tenant scopes',
    desc: 'Request the message, chat and resource scopes, the two basic-contact read scopes, and tenant:tenant:readonly, then publish.'
  },
  {
    icon: 'users',
    title: 'Add the bot to your group',
    desc: 'Invite the bot into the target chat — it replies wherever it’s a member and @-mentioned.'
  }
]

const FEISHU_DELIVERY_REQS: Record<WebWizardTransport, { icon: string; title: string; desc: string }[]> = {
  socket: [
    {
      icon: 'radio',
      title: 'Use Long Connection',
      desc: 'Under Event Subscriptions, choose Long Connection and subscribe to im.message.receive_v1.'
    }
  ],
  http: [
    {
      icon: 'radio',
      title: 'Use HTTP callbacks',
      desc: 'Connect here first, then add the Request URL shown above under Event Subscriptions and subscribe to im.message.receive_v1.'
    }
  ]
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
        stop(
          FEISHU_REGISTRATION_FAILURES[status.failureReason ?? ''] ??
            'Lark/Feishu could not complete the app setup. Please try again.'
        )
      } catch (e) {
        // A missing short-lived session is terminal; ordinary network failures
        // remain retryable and the next poll keeps the setup moving.
        if (alive && e instanceof ApiError && e.status === 404) stop(FEISHU_REGISTRATION_FAILURES.expired!)
      }
    }
    const timer = setInterval(() => void tick(), 2000)
    void tick()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [close, invalidate, polling, registrationId, setError])

  usePublishedFooter(host, {
    label: saving ? 'Connecting…' : 'Connect & authorize',
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
                    title={phase === 'authorizing' ? 'App setup is in progress' : undefined}
                    className={`rounded-[6px] px-[11px] py-[5px] font-sans text-[12px] font-semibold leading-normal ${
                      on ? 'bg-(--brand-soft) text-(--brand)' : 'bg-transparent text-(--text-tertiary)'
                    } ${phase === 'authorizing' ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    {candidate === 'deeplink' ? 'One-click' : 'Manual'}
                  </button>
                )
              })}
            </div>
            <span className="min-w-0 flex-1 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
              {method === 'deeplink'
                ? `Recommended — approve in ${brand}; permissions, events and credentials are connected automatically.`
                : 'Advanced — configure a self-built app yourself and paste its credentials.'}
            </span>
          </div>
          <div className="mb-3 flex justify-end">
            <DeliveryLine
              labels={FEISHU_TRANSPORT_LABEL}
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
                      Approve the app setup in {brand}
                    </div>
                    <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                      We opened the authorization page in a new tab. Confirm the app and permissions; this dialog
                      updates automatically.
                    </div>
                    <a
                      href={registration.authorizationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="lnk mt-2 inline-flex items-center gap-[5px]"
                    >
                      Reopen {brand} setup
                      <Icon name="external-link" size={12} />
                    </a>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                    Name and create the bot
                  </div>
                  <div className="flex flex-col gap-2 desktop:flex-row">
                    <div className="fld flex-1">
                      <input
                        className="inp mn"
                        placeholder="Bot name"
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
                      {saving ? 'Creating…' : `Create ${brand} bot`}
                    </Button>
                  </div>
                  <div className="mt-[9px] flex items-start gap-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                    <Icon name="shield-check" size={13} className="mt-[1px] flex-none" />
                    <span>
                      You review the requested message, chat, resource, basic-contact and tenant-information permissions
                      before the app is created. It must belong to the same {brand} organization used by this
                      AgentConnect deployment. No App ID or Secret is shown here.
                    </span>
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
                      Create a self-built app in the {brand}&#32;console, enable the bot, then copy its App ID and App
                      Secret.
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
                        Create {brand} bot
                        <Icon name="external-link" size={14} />
                      </a>
                      <BotSetupWalkthrough
                        steps={
                          region === 'lark'
                            ? feishuWalkthroughSteps('Lark', 'open.larksuite.com')
                            : feishuWalkthroughSteps('Feishu', 'open.feishu.cn')
                        }
                        label={region === 'lark' ? 'Lark bot setup steps' : 'Feishu bot setup steps'}
                      />
                    </div>
                  </div>
                </div>
                <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                  <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                    2
                  </span>
                  <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                    Paste the App ID &amp; App Secret
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
                  <div className="fld">
                    <span className="fldlbl">App ID</span>
                    <input
                      className={`inp mn ${showErrors && !appIdOk ? 'border-(--status-error)' : ''}`}
                      placeholder="cli_…"
                      value={appId}
                      onChange={(e) => setAppId(e.target.value)}
                    />
                  </div>
                  <div className="fld">
                    <span className="fldlbl">App Secret</span>
                    <input
                      className={`inp mn ${showErrors && !secretOk ? 'border-(--status-error)' : ''}`}
                      placeholder="App Secret"
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
                        Configure HTTP callback security
                      </span>
                    </div>
                    <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
                      <div className="fld">
                        <span className="fldlbl">Verification Token</span>
                        <input
                          className={`inp mn ${showErrors && !verificationOk ? 'border-(--status-error)' : ''}`}
                          placeholder="From Event Subscriptions"
                          value={verificationToken}
                          onChange={(e) => setVerificationToken(e.target.value)}
                        />
                      </div>
                      <div className="fld">
                        <span className="fldlbl">
                          Encrypt Key <span className="font-normal text-(--text-tertiary)">· optional</span>
                        </span>
                        <input
                          className="inp mn"
                          placeholder="From Event Subscriptions"
                          value={encryptKey}
                          onChange={(e) => setEncryptKey(e.target.value)}
                        />
                      </div>
                    </div>
                    {callbackUrl && (
                      <div className="mt-[10px] pl-[30px]">
                        <div className="fld">
                          <span className="fldlbl">Request URL</span>
                          <input
                            className="inp mn"
                            readOnly
                            value={callbackUrl}
                            onFocus={(e) => e.currentTarget.select()}
                          />
                        </div>
                        <div className="mt-[6px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                          Connect here first, then save this Request URL in {brand}. It starts receiving as soon as the
                          integration is connected.
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
            {brand} setup checklist
          </div>
          <ul className="flex flex-col gap-[10px]">
            {[
              ...FEISHU_COMMON_REQS.slice(0, 1),
              ...FEISHU_DELIVERY_REQS[checklistTransport],
              ...FEISHU_COMMON_REQS.slice(1)
            ].map((r) => (
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

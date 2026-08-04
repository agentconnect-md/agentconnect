// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useEffect, useRef, useState } from 'react'
import { PlatformMark } from '@/components/marks'
import { Button, Icon } from '@/components/ui'
import { ApiError } from '@/lib/api'
import { agentIconBackgroundColor } from '@/lib/agent-icon'
import type { Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import {
  slackAppIdFromAppToken,
  slackAppOAuthUrl,
  slackAppSettingsUrl,
  slackCreateAppUrl,
  slackManifestJson
} from './manifest'
import type { WebWizardTransport, WizardHost } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { usePublishedFooter, usePublishedIdentityChrome } from '../publish'
import { DeliveryLine } from '../wizard-chrome'
import { slackApi } from './api'
import { SlackConfigTokenPreview, SlackManifestPreview } from './previews'

/** This platform's delivery vocabulary — {@link WebTransportAffordance.labels}. */
export const SLACK_TRANSPORT_LABEL: Record<WebWizardTransport, string> = {
  socket: 'Socket Mode',
  http: 'HTTP (Events API)'
}

// Why a platform "Add to Slack" round trip ended without connecting. Keyed by the
// CP's short reason code (the same note its close page shows).
const PLATFORM_INSTALL_FAILURES: Record<string, string> = {
  denied: 'The install was cancelled in Slack.',
  expired: 'This install link expired — start again.',
  workspace_taken: 'That Slack workspace is already connected to another organization.',
  workspace_mismatch: 'Slack authorized a different workspace. Start again and choose the expected workspace.',
  agent_taken: 'That Slack workspace is already connected to another agent here. Remove that integration first.',
  error: 'Slack could not complete the install. Please try again.'
}

/**
 * Slack's pane — three funnels behind one fragment:
 *
 *  - the platform-published one-click "Add to Slack" app, which REPLACES the
 *    host's whole Bot-identity chassis (published through
 *    {@link WizardHost.setIdentityChrome} — this pane never reaches into host
 *    chrome) and commits via its own inline button;
 *  - the Tier-B config-token auto install (create the app with the caller's own
 *    App Configuration Token, approve OAuth in another tab, finalize);
 *  - the manual manifest flow (copy our manifest into Slack, paste the tokens
 *    back).
 *
 * All three write to the SAME host-owned axes (transport, shared, the footer),
 * which is exactly why those live on {@link WizardHost} and not in here.
 */
export function SlackWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const { finalizeSlackInstall } = useConsoleData()
  // The chassis reads this same probe for its relay capability; one SWR key ⇒
  // one request. The funnel flags on the DTO are Slack's alone.
  const probe = useDeploymentConfig(true)

  // Prefilled from the agent's name so the manifest carries a real app name out of
  // the box; still editable, and empty falls back to `agent.name` for the manifest.
  const [appName, setAppName] = useState(agent.name)
  const [botToken, setBotToken] = useState('')
  const [appToken, setAppToken] = useState('')
  const [signingSecret, setSigningSecret] = useState('') // http manual credential
  // "Create a new bot" method: 'config' = recommended config-token quick install
  // (works for socket AND http), 'bot' = manual bot-token flow. Null ⇒ derive the default.
  const [createMethod, setCreateMethod] = useState<'config' | 'bot' | null>(null)
  // Inline config-token entry, shown under the config method — saved to the same per-user
  // store as the Profile card (so it appears there too).
  const [cfgAccess, setCfgAccess] = useState('')
  const [cfgRefresh, setCfgRefresh] = useState('')
  // config → authorizing (OAuth in the other tab) → appToken (bot ready, paste xapp).
  const [autoPhase, setAutoPhase] = useState<'config' | 'authorizing' | 'appToken'>('config')
  const [install, setInstall] = useState<{
    installId: string
    appId: string
    installUrl: string
    transport: WebWizardTransport
  } | null>(null)
  // The caller's stored config token is usable for a one-click install RIGHT NOW.
  // Null ⇒ take the probe's answer; a local value overrides it after this pane has
  // learned something newer (a successful save, or a re-read after a rejection).
  const [autoUsableOverride, setAutoUsableOverride] = useState<boolean | null>(null)
  // Did the operator pick the transport by hand? The config-token commit derives
  // its default from the FRESH save response rather than the probe, so it has to
  // know whether the current value is a choice or a default.
  const [transportPicked, setTransportPicked] = useState(false)
  const [platformPhase, setPlatformPhase] = useState<'idle' | 'authorizing'>('idle')
  const [platformErr, setPlatformErr] = useState<string | null>(null)
  // The pending platform install being polled (its id doubles as the OAuth state).
  const [platformInstallId, setPlatformInstallId] = useState<string | null>(null)
  // Which Bot-identity pane shows: the one-click BUILT-IN app (the default whenever
  // the platform app is configured) or the custom bot flow behind the "Use a custom
  // bot identity" disclosure.
  const [slackIdentity, setSlackIdentity] = useState<'builtin' | 'custom'>('builtin')
  const [showErrors, setShowErrors] = useState(false)
  const [saving, setSaving] = useState(false)
  // Synchronous re-entry guard for the async actions. `saving` state can't do this —
  // it commits on the NEXT render, so a fast double-click fires two calls in the same
  // tick (both see saving=false). A ref flips immediately, so the second click bails —
  // otherwise a double "Create app & install" spawns two Slack apps / two OAuth tabs
  // and the modal ends up polling an install the user never approved.
  const busyRef = useRef(false)

  // `funnel`: null = still checking, true = this deployment supports auto-install
  // (public callback), false = manual. An answer WINS over a later error: the
  // monolith read this endpoint once per open and never re-read, so a funnel it
  // had already learned could not be retracted. The shared probe is SWR and does
  // revalidate (remount, reconnect), and a transient failure there must not swap
  // a working config-token flow for the manual manifest flow. Only a probe with
  // no answer at all falls back to manual.
  const funnel: boolean | null = probe.config ? probe.config.funnelEnabled : probe.failed ? false : null
  const autoUsable = autoUsableOverride ?? probe.config?.autoAvailable ?? false
  // The DEPLOYMENT probe for the platform-published app; whether THIS agent may
  // use it is `builtinAppOffered`.
  const platformAvailable = probe.config?.platformInstallAvailable === true
  const relayAvailable = host.relayCapability.available
  const relayPublicUrl = host.relayCapability.publicUrl

  // …offered on the BUILT-IN preset agent only (preset-agents.md §5.3): the platform
  // app is one deployment-level Slack app whose workspace install binds to the org's
  // `agentconnect` preset. Clicking it from any other agent is a dead end — the
  // workspace is already taken by the preset, and the callback answers `agent_taken`.
  const builtinAppOffered = platformAvailable && agent.builtin === true
  const checking = funnel === null
  const builtin = funnel !== null && builtinAppOffered && slackIdentity === 'builtin'
  // The built-in pane and the funnel probe's spinner each REPLACE the host's whole
  // identity chassis; the host renders neither the header/mode-cards/free-bot-list
  // nor the share toggle while this is true.
  const hideIdentity = checking || builtin

  // Once an auto-install is pending, PIN the transport to what the app was actually
  // created as — the pane stops offering its switch (`locked`) rather than letting a
  // post-start switch drive the wrong finalize path.
  const transport: WebWizardTransport = install ? install.transport : host.transport
  const switchTransport = (next: WebWizardTransport) => {
    setTransportPicked(true)
    host.setTransport(next)
  }

  // Slack: bot token (xoxb-) + either an app-level Socket Mode token (xapp-, socket)
  // or a signing secret (http). Signing secrets are 32 hex chars; keep the guard lenient.
  const tokenTrim = botToken.trim()
  const botOk = tokenTrim.startsWith('xoxb-')
  const appOk = appToken.trim().startsWith('xapp-')
  const signingOk = signingSecret.trim().length >= 16
  const createValid = transport === 'http' ? botOk && signingOk : botOk && appOk

  // The app-level token embeds the app id (xapp-1-{APP_ID}-…); once it's pasted we can
  // deep-link straight to THIS app's Slack pages — chiefly the OAuth & Permissions page
  // where the bot token lives — instead of hunting through menus.
  const pastedAppId = slackAppIdFromAppToken(appToken)

  // Manifest names mirror the agent's naming model: the app name is what the user
  // typed, else the agent's `name` (slug); the channel display name is the agent's
  // `displayName`, falling back to the app name when unset.
  const manifestNames = {
    name: appName.trim() || agent.name,
    ...(agent.displayName ? { displayName: agent.displayName } : {})
  }
  // Manifest transport mirrors the create-path choice; the http request_urls point
  // at the relay's public base (omitted ⇒ buildSlackManifest falls back to socket).
  const manifestOpts = {
    mode: transport,
    // Brand the created app with the agent's icon color (matches the CP auto-install
    // funnel) — Slack has no API to set the app image itself.
    backgroundColor: agentIconBackgroundColor(agent.icon),
    ...(relayPublicUrl ? { relayUrl: relayPublicUrl } : {})
  }
  const manifestJson = slackManifestJson(manifestNames, manifestOpts)
  const createUrl = slackCreateAppUrl(manifestNames, manifestOpts)

  // Config token is the recommended method for both transports; `bot` is the manual
  // fallback the user can switch to. Default to config when the funnel is enabled.
  const method: 'config' | 'bot' = createMethod ?? (funnel === true ? 'config' : 'bot')
  const selectMethod = (m: 'config' | 'bot') => {
    // Locked once an auto-install has created the app + pending row: switching methods
    // here would route the footer through the manual `submit()` and orphan that install.
    if (install) return
    setCreateMethod(m)
    setShowErrors(false)
    host.setError(null)
  }
  const isAuto = funnel === true && method === 'config' && autoUsable
  // Config method chosen but nothing usable stored yet ⇒ the inline config-token entry
  // is shown and the footer commits it (save + create the app).
  const isConfigSetup = funnel === true && method === 'config' && !autoUsable

  const submit = async () => {
    setShowErrors(true)
    if (busyRef.current || !createValid) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      // shareable is attached ONLY under http (a socket bot can never be shared).
      await host.createIntegration(
        transport === 'http'
          ? {
              platform: 'slack',
              agentId: agent.id,
              transport: 'http',
              ...(appName.trim() ? { name: appName.trim() } : {}),
              ...(host.shared ? { shareable: true } : {}),
              slack: { botToken: tokenTrim, signingSecret: signingSecret.trim() }
            }
          : {
              platform: 'slack',
              agentId: agent.id,
              transport: 'socket',
              ...(appName.trim() ? { name: appName.trim() } : {}),
              slack: { botToken: tokenTrim, appToken: appToken.trim() }
            }
      )
      host.close()
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  // Config-token method commit: store the pasted configuration token (same per-user store
  // as the Profile card), then immediately create the Slack app + open OAuth — the CP uses
  // the stored config token to mint the app. Refresh token optional (access-only lasts ~12h;
  // a refresh token keeps it from expiring).
  const saveConfigAndStart = async () => {
    setShowErrors(true)
    if (busyRef.current || !cfgAccess.trim() || install) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      const refreshTrim = cfgRefresh.trim()
      const s = await slackApi.saveConfig({
        accessToken: cfgAccess.trim(),
        ...(refreshTrim ? { refreshToken: refreshTrim } : {})
      })
      // Publishing the fresh status is how the deployment relay capability (and the
      // manifest/transport rules reading it) learn what the save just changed. It also
      // carries `autoAvailable: true` the instant the token is stored, so pin the local
      // override to the PRE-save answer first — otherwise applying it flips this pane to
      // the auto flow mid-request, before the app the next comment is about exists.
      setAutoUsableOverride(autoUsable)
      probe.apply(s)
      // Create the app BEFORE flipping to the auto flow: this is where Slack first
      // validates the config token (access-only tokens aren't validated on save). Keeping
      // the flip until AFTER success means a rejected/typo'd or already-expired token stays
      // recoverable in the inline entry (fields kept, still on the config-setup branch).
      const nextTransport: WebWizardTransport = transportPicked ? transport : s.relayAvailable ? 'http' : 'socket'
      const started = await slackApi.startInstall({
        agentId: agent.id,
        transport: nextTransport,
        ...(appName.trim() ? { name: appName.trim() } : {})
      })
      // App + pending install created ⇒ now it's safe to move to the auto flow.
      setAutoUsableOverride(true)
      setInstall(started)
      host.setTransport(started.transport)
      setAutoPhase('authorizing')
      setCfgAccess('')
      setCfgRefresh('')
      window.open(started.installUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      // The app wasn't created. Re-read status rather than blindly deleting: the CP drops
      // only a rejected ACCESS-ONLY token server-side, so autoAvailable now reflects reality
      // — a rejected access-only token flips false and stays on the inline entry (re-prompt,
      // fields kept for correction), while a durable config or a transient failure stays
      // usable so a retry works.
      try {
        const c = await slackApi.readConfig()
        setAutoUsableOverride(c.autoAvailable)
        probe.apply(c)
      } catch {
        setAutoUsableOverride(false)
      }
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // Auto flow — step 1: create the app (with the caller's stored config token) + open
  // the Slack OAuth install in a new tab.
  const startAuto = async () => {
    // `install` guard: once a start has succeeded, never create a second app.
    if (busyRef.current || install) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      const started = await slackApi.startInstall({
        agentId: agent.id,
        transport,
        ...(appName.trim() ? { name: appName.trim() } : {})
      })
      setInstall(started)
      host.setTransport(started.transport)
      setAutoPhase('authorizing')
      window.open(started.installUrl, '_blank', 'noopener,noreferrer')
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      // Re-read status: if the CP invalidated a rejected access-only token (incl. one saved
      // from Profile), autoAvailable flips false and the modal falls back to the inline
      // config-token entry so the caller can re-enter it; a durable config stays usable so
      // "Create & install" can retry.
      try {
        setAutoUsableOverride((await slackApi.readConfig()).autoAvailable)
      } catch {
        /* keep current state */
      }
    } finally {
      setSaving(false)
      busyRef.current = false
    }
  }

  // Abandon the current pending install and return to the config step — the escape
  // hatch when the Slack approval was denied / never finished (otherwise the poll sits
  // on "Waiting for Slack…" forever). The orphaned pending row is reaped by TTL.
  const restartAuto = () => {
    if (busyRef.current) return
    setInstall(null)
    setAutoPhase('config')
    host.setError(null)
  }

  // Auto flow — final step. Socket: hand the CP the pasted app-level token; it
  // combines it with the OAuth-obtained bot token to create the bot + integration.
  // Http: no token — the CP reads the signing secret via the caller's config token,
  // so finalize is fully automatic.
  const finalizeAuto = async () => {
    setShowErrors(true)
    if (busyRef.current || !install) return
    if (transport === 'socket' && !appOk) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      await finalizeSlackInstall(install.installId, {
        // socket: the pasted app-level token; http: none. The shared choice rides here too.
        ...(transport === 'socket' ? { appToken: appToken.trim() } : {}),
        ...(host.shared ? { shareable: true } : {})
      })
      host.close()
    } catch (e) {
      host.setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
      busyRef.current = false
    }
  }

  // Kick off the platform-app install: mint the state-bound authorize URL and open
  // it in a popup. The install row's id is what the poll below follows.
  const startPlatformInstall = async () => {
    if (busyRef.current) return
    setPlatformErr(null)
    try {
      const r = await slackApi.startPlatformInstall({ agentId: agent.id })
      setPlatformInstallId(r.id)
      window.open(r.installUrl, '_blank', 'noopener,width=680,height=760')
      setPlatformPhase('authorizing')
    } catch (e) {
      setPlatformErr(e instanceof Error ? e.message : String(e))
    }
  }

  const { close } = host
  const mode = host.mode

  // While the user approves in the Slack tab, poll the INSTALL ROW for its terminal
  // state. Watching the integration list for a new row would hang on the common
  // re-authorization path: re-installing a workspace this agent already has only
  // rotates the token server-side and creates no integration.
  useEffect(() => {
    if (mode !== 'create' || platformPhase !== 'authorizing' || !platformInstallId) return
    let alive = true
    const stop = (message: string) => {
      setPlatformPhase('idle')
      setPlatformInstallId(null)
      setPlatformErr(message)
    }
    const tick = async () => {
      try {
        const s = await slackApi.getPlatformInstall(platformInstallId)
        if (!alive || s.status === 'pending') return
        if (s.status === 'completed') return close() // lists refetch on close
        stop(PLATFORM_INSTALL_FAILURES[s.failureReason ?? ''] ?? 'The Slack install did not complete.')
      } catch (e) {
        // 404 = the row was TTL-reaped (an abandoned tab), which is terminal —
        // anything else is transient, so keep polling.
        if (alive && e instanceof ApiError && e.status === 404) stop(PLATFORM_INSTALL_FAILURES.expired!)
      }
    }
    const h = setInterval(() => void tick(), 2500)
    void tick()
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [close, mode, platformPhase, platformInstallId])

  // While the user approves the install in the other tab, poll until the CP has the
  // bot token, then reveal the app-level-token step. Cleared on close / phase change.
  const installId = install?.installId ?? null
  useEffect(() => {
    if (mode !== 'create' || funnel !== true || autoPhase !== 'authorizing' || !installId) return
    let alive = true
    const tick = async () => {
      try {
        const s = await slackApi.getInstall(installId)
        if (alive && s.status === 'bot_ready') setAutoPhase('appToken')
      } catch {
        /* transient — keep polling */
      }
    }
    const h = setInterval(() => void tick(), 2500)
    void tick()
    return () => {
      alive = false
      clearInterval(h)
    }
  }, [autoPhase, funnel, installId, mode])

  // The footer primary adapts to the flow. In the auto flow each STEP owns its own
  // action inline (step ① "Create & install" next to the name; step ② the token field),
  // so the footer is the final commit — "Connect" (finalize), live only once the app is
  // installed and a valid app-level token is pasted. Auto-install works for BOTH
  // transports: socket ends with the operator pasting the app-level (xapp) token; http
  // is fully automatic — the CP builds an Events-API manifest and captures the signing
  // secret from apps.manifest.create, so there's no paste step.
  const primary = isAuto
    ? {
        label: 'Connect',
        onSubmit: () => void finalizeAuto(),
        // Enabled once the install reaches bot-ready. Socket also needs the pasted
        // app-level token; http finalizes with none (signing secret already captured).
        enabled: autoPhase === 'appToken' && (transport === 'http' || appOk)
      }
    : isConfigSetup
      ? { label: 'Connect & authorize', onSubmit: () => void saveConfigAndStart(), enabled: !!cfgAccess.trim() }
      : { label: 'Connect & authorize', onSubmit: () => void submit(), enabled: createValid }
  usePublishedFooter(host, {
    ...primary,
    label: saving ? (isAuto && autoPhase === 'config' ? 'Creating…' : 'Connecting…') : primary.label,
    enabled: primary.enabled && !saving,
    // The built-in pane's action is its own Add-to-Slack button (the modal closes
    // itself when the install lands), so the custom flow's footer action hides.
    hidden: hideIdentity
  })
  usePublishedIdentityChrome(host, {
    hidden: hideIdentity,
    // Way back to the simple pane — only meaningful when the platform app exists
    // AND this agent is the preset it binds to.
    ...(builtinAppOffered
      ? { headerAction: { label: 'Use the built-in Slack app', onSelect: () => setSlackIdentity('builtin') } }
      : {})
  })

  return (
    <>
      {/* Built-in Slack app pane (design: builtin-first) — one branded button and a
          caption; it REPLACES the whole Bot-identity section, which returns via the
          "Use a custom bot identity" disclosure below. */}
      {builtin && (
        <>
          <div className="mb-3 rounded-[9px] border border-(--border-subtle) bg-(--surface-card) p-4">
            {platformPhase === 'authorizing' ? (
              <div className="flex h-[46px] w-full items-center justify-center gap-[10px] rounded-[10px] bg-(--surface-inverse) font-sans text-[14px] font-semibold leading-normal text-white opacity-85">
                <Icon name="loader" size={16} className="flex-none animate-spin" />
                Waiting for Slack…
              </div>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() => void startPlatformInstall()}
                className="flex h-[46px] w-full cursor-pointer items-center justify-center gap-[10px] rounded-[10px] border-0 bg-(--surface-inverse) font-sans text-[14px] font-semibold leading-normal text-white"
              >
                <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                  <PlatformMark platform="slack" />
                </span>
                Add to Slack
              </button>
            )}
            {platformErr && (
              <div className="mt-2 font-sans text-[11.5px] font-normal leading-[1.4] text-(--danger)">
                {platformErr}
              </div>
            )}
            <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
              {platformPhase === 'authorizing'
                ? 'Approve the install in the Slack tab — this closes automatically once it lands.'
                : 'Installs the built-in AgentConnect Slack app.'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSlackIdentity('custom')}
            className="mb-4 flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)"
          >
            <Icon name="chevron-right" size={14} color="var(--text-tertiary)" />
            Use a custom bot identity instead
          </button>
        </>
      )}
      {mode === 'create' && !builtin && (
        <>
          {funnel === null ? (
            <div className="mb-4 flex items-center gap-[10px] rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              <Icon name="loader" size={15} className="flex-none animate-spin" />
              Checking your Slack setup…
            </div>
          ) : (
            <>
              {funnel === true && (
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-[6px]">
                  <div className="inline-flex flex-none rounded-lg border border-(--border-default) bg-(--surface-card) p-[3px]">
                    {(['config', 'bot'] as const).map((m) => {
                      const on = method === m
                      return (
                        <button
                          key={m}
                          type="button"
                          disabled={!!install}
                          onClick={() => selectMethod(m)}
                          title={install ? 'Install in progress — “Start over” to switch method' : undefined}
                          className={`rounded-[6px] px-[11px] py-[5px] font-sans text-[12px] font-semibold leading-normal ${
                            on ? 'bg-(--brand-soft) text-(--brand)' : 'bg-transparent text-(--text-tertiary)'
                          } ${install ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          {m === 'config' ? 'Config token' : 'Bot token'}
                        </button>
                      )
                    })}
                  </div>
                  <span className="min-w-0 flex-1 font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
                    {method === 'config'
                      ? 'Recommended — one-click install, no manifest to copy or tokens to paste.'
                      : 'Manual — copy our manifest into Slack, install, and paste the tokens back.'}
                  </span>
                </div>
              )}
              {method === 'config' && autoUsable ? (
                <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                  <div className="mb-[14px]">
                    <DeliveryLine
                      labels={SLACK_TRANSPORT_LABEL}
                      transport={transport}
                      relayAvailable={relayAvailable}
                      locked={!!install}
                      onSwitch={switchTransport}
                    />
                  </div>

                  {/* Step 1 — create & install (content changes by phase). */}
                  <div className="flex gap-[10px]">
                    {autoPhase === 'appToken' ? (
                      <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--brand-soft)">
                        <Icon name="check" size={12} color="var(--brand)" />
                      </span>
                    ) : (
                      <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                        1
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      {autoPhase === 'config' && (
                        <>
                          <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                            Name &amp; create the app (name optional)
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="fld flex-1">
                              <input
                                className="inp mn"
                                placeholder={
                                  manifestNames.name
                                    ? `${manifestNames.name} — from the agent's name`
                                    : 'Bot name (optional) — e.g. acme-agent'
                                }
                                value={appName}
                                onChange={(e) => setAppName(e.target.value)}
                              />
                            </div>
                            <Button
                              onClick={() => void startAuto()}
                              className={saving ? 'flex-none cursor-default opacity-50' : 'flex-none'}
                            >
                              <Icon name="plus" size={14} />
                              {saving ? 'Creating…' : 'Create & install'}
                            </Button>
                          </div>
                        </>
                      )}
                      {autoPhase === 'authorizing' && (
                        <>
                          <div className="flex items-center gap-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                            <Icon name="loader" size={14} className="flex-none animate-spin" />
                            Approve the install in Slack
                          </div>
                          <div className="mt-[3px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                            We opened Slack in a new tab — click &ldquo;Allow&rdquo;, then come back. This updates
                            automatically.
                          </div>
                          {install && (
                            <div className="mt-2 flex items-center gap-[14px]">
                              <a
                                href={install.installUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="lnk inline-flex items-center gap-[5px]"
                              >
                                Reopen the Slack install
                                <Icon name="external-link" size={12} />
                              </a>
                              <button type="button" className="lnk" onClick={restartAuto}>
                                Start over
                              </button>
                            </div>
                          )}
                        </>
                      )}
                      {autoPhase === 'appToken' && (
                        <div className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                          {transport === 'http'
                            ? 'App created & installed — click Connect to finish'
                            : 'App created & installed — bot token secured'}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Step 2 — app-level token. Socket only: http needs no xapp paste
                  (the CP reads the signing secret itself), so the footer Connect
                  finalizes directly once the install is approved. */}
                  {transport === 'socket' && (
                    <div
                      className={`mt-[14px] border-t border-dashed border-(--border-default) pt-[13px] ${
                        autoPhase === 'appToken' ? '' : 'opacity-55'
                      }`}
                    >
                      <div className="flex gap-[10px]">
                        <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                          2
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                            Generate the App-Level token &amp; paste it{' '}
                            <span className="font-normal text-(--text-tertiary)">(Slack has no API for this one)</span>
                          </div>
                          <div className="fld">
                            <input
                              className={`inp mn ${showErrors && !appOk ? 'border-(--status-error)' : ''}`}
                              placeholder="xapp-…"
                              value={appToken}
                              onChange={(e) => setAppToken(e.target.value)}
                              disabled={autoPhase !== 'appToken'}
                            />
                          </div>
                          {autoPhase === 'appToken' && install ? (
                            <a
                              href={slackAppSettingsUrl(install.appId)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="lnk mt-[10px] inline-flex items-center gap-[5px]"
                            >
                              Generate the App-Level token
                              <Icon name="external-link" size={12} />
                            </a>
                          ) : (
                            <div className="mt-[8px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                              Unlocks once you approve the install in Slack.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : method === 'config' ? (
                <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                  {/* Step 1 — open Slack's App Configuration Tokens page (hover previews
                  where it lives: scroll to the bottom of Your apps, then Copy). */}
                  <div className="flex gap-[10px]">
                    <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                      1
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="cfgtok relative">
                        <SlackConfigTokenPreview />
                        <a
                          href="https://api.slack.com/apps"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                        >
                          <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                            <PlatformMark platform="slack" />
                          </span>
                          Open Slack app config tokens
                          <Icon name="external-link" size={14} />
                        </a>
                      </div>
                      <div className="mt-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                        Under <span className="mono">Your apps</span> →{' '}
                        <span className="mono">configuration tokens</span>, pick the workspace and generate a token
                        pair. The app is created in that workspace.
                      </div>
                    </div>
                  </div>
                  {/* Step 2 — paste the configuration token pair (one row; hints inline). */}
                  <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                    <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                      2
                    </span>
                    <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                      Paste your configuration token
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-[10px] pl-[30px] min-[440px]:grid-cols-2">
                    <div className="fld">
                      <span className="fldlbl">
                        Access Token <span className="font-normal text-(--text-tertiary)">· required</span>
                      </span>
                      <input
                        className={`inp mn ${showErrors && !cfgAccess.trim() ? 'border-(--status-error)' : ''}`}
                        placeholder="xoxe.xoxp-1-…"
                        value={cfgAccess}
                        onChange={(e) => setCfgAccess(e.target.value)}
                      />
                    </div>
                    <div className="fld">
                      <span className="fldlbl">
                        Refresh Token{' '}
                        <span className="font-normal text-(--text-tertiary)">· optional, saved for reuse</span>
                      </span>
                      <input
                        className="inp mn"
                        placeholder="xoxe-1-…"
                        value={cfgRefresh}
                        onChange={(e) => setCfgRefresh(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
                  {/* Step 1 — create & install from our manifest. The agent name is
                  built into the manifest, so no separate name field here. */}
                  <div className="mb-3 flex gap-[10px]">
                    <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                      1
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                        Create &amp; install the Slack app from our manifest
                      </div>
                      <div className="group relative">
                        <a
                          href={createUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => void navigator.clipboard?.writeText?.(manifestJson)?.catch?.(() => {})}
                          className="flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
                        >
                          <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
                            <PlatformMark platform="slack" />
                          </span>
                          Copy manifest &amp; open Slack
                          <Icon name="external-link" size={14} />
                        </a>
                        <SlackManifestPreview />
                      </div>
                      <div className="mt-[7px] font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                        In Slack, choose <span className="font-medium text-(--text-secondary)">From a manifest</span>,
                        paste, select a workspace, then create and install the app.
                      </div>
                      <DeliveryLine
                        labels={SLACK_TRANSPORT_LABEL}
                        transport={transport}
                        relayAvailable={relayAvailable}
                        locked={false}
                        onSwitch={switchTransport}
                      />
                    </div>
                  </div>
                  {/* Step 2 — paste the tokens the install gives back. */}
                  <div className="mt-[14px] mb-[11px] flex items-center gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]">
                    <span className="mono flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
                      2
                    </span>
                    <span className="font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
                      Paste the tokens it gives you — required to connect
                    </span>
                  </div>
                  <div className="pl-[30px]">
                    <div className="grid grid-cols-1 gap-[10px] min-[440px]:grid-cols-2">
                      <div className="fld">
                        <span className="fldlbl">Bot token</span>
                        <input
                          className={`inp mn ${showErrors && !botOk ? 'border-(--status-error)' : ''}`}
                          placeholder="xoxb-…"
                          value={botToken}
                          onChange={(e) => setBotToken(e.target.value)}
                        />
                      </div>
                      {transport === 'http' ? (
                        <div className="fld">
                          <span className="fldlbl">Signing secret</span>
                          <input
                            className={`inp mn ${showErrors && !signingOk ? 'border-(--status-error)' : ''}`}
                            placeholder="Signing secret (Basic Information → App Credentials)"
                            value={signingSecret}
                            onChange={(e) => setSigningSecret(e.target.value)}
                          />
                        </div>
                      ) : (
                        <div className="fld">
                          <span className="fldlbl">App-level token</span>
                          <input
                            className={`inp mn ${showErrors && !appOk ? 'border-(--status-error)' : ''}`}
                            placeholder="xapp-…"
                            value={appToken}
                            onChange={(e) => setAppToken(e.target.value)}
                          />
                        </div>
                      )}
                    </div>
                    {/* Socket: once the app-level token decodes, deep-link to the app's
                    Bot-token + settings pages (progressive — hidden until pasted). */}
                    {transport === 'socket' && pastedAppId && (
                      <div className="mt-[10px] flex flex-wrap items-center gap-x-[14px] gap-y-1 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                        <span className="flex items-center gap-[5px]">
                          <Icon name="corner-down-right" size={12} className="flex-none" />
                          App&nbsp;<span className="mono">{pastedAppId}</span>
                        </span>
                        <a
                          href={slackAppOAuthUrl(pastedAppId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="lnk inline-flex items-center gap-[5px]"
                        >
                          Copy the Bot token
                          <Icon name="external-link" size={12} />
                        </a>
                        <a
                          href={slackAppSettingsUrl(pastedAppId)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="lnk inline-flex items-center gap-[5px]"
                        >
                          Open app settings
                          <Icon name="external-link" size={12} />
                        </a>
                      </div>
                    )}
                    {/* Bot-token path only: getting the Bot User OAuth token means installing
                    the app, and if Slack flags changed scopes it shows a "reinstall your
                    app" banner — reinstalling once is what activates the token pasted above. */}
                    <div className="mt-[11px] flex items-start gap-2 rounded-lg bg-(--status-paused-soft) px-[11px] py-[9px]">
                      <Icon
                        name="triangle-alert"
                        size={14}
                        color="var(--status-paused)"
                        className="mt-[1px] flex-none"
                      />
                      <span className="min-w-0 flex-1 font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-secondary)">
                        If Slack shows{' '}
                        <span className="font-medium">“You’ve changed the permission scopes… reinstall your app”</span>,
                        click <span className="font-medium">Reinstall</span> once — that’s what activates the Bot User
                        OAuth token you paste above.
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}

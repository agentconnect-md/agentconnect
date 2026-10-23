// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { IntegrationDto } from '@/lib/api'
import type { Agent } from '@/lib/data'
import type { WizardHost } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { usePublishedFooter, usePublishedIdentityChrome } from '../publish'
import { BotSetupWalkthrough } from '../wizard-chrome'
import { msTeamsApi } from './api'
import { AppPackageButton } from './app-package'
import { CopyField } from './fields'
import { MsTeamsMark } from './mark'
import { useMsTeamsDeploymentApp } from './deployment-app'
import { useOrgs } from '@/lib/org-context'
import { msTeamsWalkthroughSteps } from './steps'
import {
  MSTEAMS_ADMIN_APPS_URL,
  MSTEAMS_BOT_PORTAL_URL,
  guidOk,
  msTeamsErrorMessage,
  msTeamsMessagesUrl
} from './setup'

// Literal class strings, never assembled (STYLE.md §8).
const LINK_BUTTON =
  'flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) px-3 font-sans text-[13px] font-semibold leading-normal text-white no-underline'
const ID_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'

/** Which pane shows: the probe in flight, no relay to receive activities, the deployment app, the registration steps, or the install step. */
export type MsTeamsPane = 'checking' | 'relay_required' | 'deployment' | 'register' | 'install'

/** The pane for the wizard's current facts; pure so the step flow is testable without rendering. */
export function msTeamsPane(input: {
  relayAvailable: boolean | null
  created: boolean
  /** Whether the deployment's Teams app is offered; null while that is read. */
  deploymentApp?: boolean | null
  ownBot?: boolean
}): MsTeamsPane {
  if (input.created) return 'install'
  if (input.relayAvailable === null) return 'checking'
  if (!input.relayAvailable) return 'relay_required'
  if (input.ownBot) return 'register'
  if (input.deploymentApp === null) return 'checking'
  return input.deploymentApp ? 'deployment' : 'register'
}

/** Microsoft Teams' pane (teams-integration.md §5): register a bot, paste its credentials, then download and install the app package. */
export function MsTeamsWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.msteams')
  const stepsT = useTranslations('Platforms.msteams.steps')
  const translate = (key: Parameters<typeof t>[0]) => t(key)
  // The chassis reads this same probe for its relay capability; only "has it answered" is read here.
  const probe = useDeploymentConfig(true)
  const [appId, setAppId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<IntegrationDto | null>(null)
  // The person chose to register their own bot over the deployment's Teams app.
  const [ownBot, setOwnBot] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const deploymentApp = useMsTeamsDeploymentApp(host.mockMode)
  const { activeOrg } = useOrgs()
  // Synchronous re-entry guard; `saving` only commits on the next render.
  const busyRef = useRef(false)

  // An answer wins over a later error, as in the other relay-only panes.
  const relayAvailable: boolean | null = probe.config ? host.relayCapability.available : probe.failed ? false : null
  const pane = msTeamsPane({ relayAvailable, created: !!created, deploymentApp, ownBot })

  // Leaves for Microsoft's sign-in; the connect page finishes the install there.
  const connect = async () => {
    if (busyRef.current || !activeOrg) return
    busyRef.current = true
    setConnecting(true)
    host.setError(null)
    try {
      const { authorizeUrl } = await msTeamsApi.connect(activeOrg.id, agent.id)
      window.location.assign(authorizeUrl)
    } catch (e) {
      host.setError(msTeamsErrorMessage(e, translate))
      setConnecting(false)
      busyRef.current = false
    }
  }
  const endpoint = msTeamsMessagesUrl(host.relayCapability.publicUrl)

  const appIdOk = guidOk(appId)
  const tenantIdOk = guidOk(tenantId)
  const valid = appIdOk && tenantIdOk && !!clientSecret.trim()

  const submit = async () => {
    if (busyRef.current || !valid) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    try {
      const integration = await msTeamsApi.create({
        platform: 'msteams',
        agentId: agent.id,
        transport: 'http',
        msteams: { appId: appId.trim(), tenantId: tenantId.trim(), clientSecret: clientSecret.trim() }
      })
      host.invalidate()
      setCreated(integration)
    } catch (e) {
      host.setError(msTeamsErrorMessage(e, translate))
    } finally {
      // Write-only: the secret leaves browser state once it has been submitted, whatever the answer.
      setClientSecret('')
      setSaving(false)
      busyRef.current = false
    }
  }

  // Only the registration steps use the host's identity chassis and footer; the install step carries its own action.
  const register = pane === 'register'
  usePublishedIdentityChrome(host, { hidden: !register })
  usePublishedFooter(host, {
    label: saving ? t('footer.checking') : t('footer.connect'),
    enabled: register && valid && !saving,
    onSubmit: () => void submit(),
    hidden: !register
  })

  if (pane === 'checking') {
    return (
      <Frame>
        <div className="flex items-center gap-[10px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="loader" size={15} className="flex-none animate-spin" />
          {t('checking')}
        </div>
      </Frame>
    )
  }

  if (pane === 'relay_required') {
    return (
      <Frame>
        <div className="flex items-start gap-[10px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary)">
          <Icon name="info" size={15} className="mt-[1px] flex-none" />
          <span>{t('relayRequired')}</span>
        </div>
      </Frame>
    )
  }

  if (pane === 'deployment') {
    return (
      <>
        <div className="mb-3 rounded-[9px] border border-(--border-subtle) bg-(--surface-card) p-4">
          <button
            type="button"
            disabled={connecting}
            onClick={() => void connect()}
            className={`${LINK_BUTTON} w-full cursor-pointer border-0 disabled:opacity-60`}
          >
            <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
              <MsTeamsMark fillPct={100} />
            </span>
            {connecting ? t('deployment.connecting') : t('deployment.connect')}
          </button>
          <div className="mt-[10px] font-sans text-[12px] font-normal leading-[1.4] text-(--text-tertiary)">
            {t('deployment.next')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOwnBot(true)}
          className="mb-4 flex cursor-pointer items-center gap-[6px] border-0 bg-transparent p-0 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)"
        >
          <Icon name="chevron-right" size={14} color="var(--text-tertiary)" />
          {t('deployment.useOwn')}
        </button>
      </>
    )
  }

  if (pane === 'install' && created) {
    return (
      <Frame>
        <div className="mb-3 flex items-center gap-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          <Icon name="circle-check" size={15} color="var(--status-online)" className="flex-none" />
          {t('install.connected')}
        </div>
        <Step n={3} title={t('install.title')}>
          <div className="mb-[10px] flex flex-col gap-2 desktop:flex-row desktop:items-start">
            <AppPackageButton integrationId={created.id} className="dsbtn dsbtn-primary h-[38px] w-full" />
            <a
              href={MSTEAMS_ADMIN_APPS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="dsbtn dsbtn-secondary h-[38px] no-underline desktop:flex-1"
            >
              {t('install.openAdmin')}
              <Icon name="external-link" size={14} />
            </a>
          </div>
          <Bullets
            items={[t('install.upload'), t('install.addToTeam'), t('install.personal'), t('install.selfUpload')]}
          />
        </Step>
        <button type="button" onClick={host.close} className="dsbtn dsbtn-secondary mt-[14px] h-[38px] w-full">
          {t('install.done')}
        </button>
      </Frame>
    )
  }

  // Reusing a freed bot is the host's own flow; this pane only creates.
  if (host.mode !== 'create') return null

  return (
    <Frame>
      <Step n={1} title={t('register.title')} first>
        <div className="group relative mb-[10px]">
          <a href={MSTEAMS_BOT_PORTAL_URL} target="_blank" rel="noopener noreferrer" className={LINK_BUTTON}>
            <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
              <MsTeamsMark fillPct={100} />
            </span>
            {t('register.open')}
            <Icon name="external-link" size={14} />
          </a>
          <BotSetupWalkthrough
            steps={msTeamsWalkthroughSteps(stepsT, endpoint)}
            label={t('register.walkthroughLabel')}
          />
        </div>
        {endpoint && (
          <div className="mb-[10px]">
            <CopyField label={t('register.endpoint')} value={endpoint} />
          </div>
        )}
        <Bullets items={[t('register.newBot'), t('register.secret'), t('register.tenant'), t('register.azure')]} />
      </Step>
      <Step n={2} title={t('credentials.title')}>
        <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
          <label className="fld">
            <span className="fldlbl">{t('credentials.appId')}</span>
            <input
              className={`inp mn ${appId.trim() && !appIdOk ? 'border-(--status-error)' : ''}`}
              placeholder={ID_PLACEHOLDER}
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">{t('credentials.tenantId')}</span>
            <input
              className={`inp mn ${tenantId.trim() && !tenantIdOk ? 'border-(--status-error)' : ''}`}
              placeholder={ID_PLACEHOLDER}
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
            />
          </label>
          <label className="fld desktop:col-span-2">
            <span className="fldlbl">{t('credentials.clientSecret')}</span>
            <input
              className="inp mn"
              type="password"
              autoComplete="new-password"
              placeholder={t('credentials.clientSecretPlaceholder')}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </label>
        </div>
      </Step>
    </Frame>
  )
}

/** The pane's own card, so every state sits in one box. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">{children}</div>
  )
}

/** One numbered setup step, in the paste-credentials pane's idiom (`TokenGuidePane`). */
function Step({ n, title, first, children }: { n: number; title: string; first?: boolean; children: ReactNode }) {
  return (
    <div
      className={
        first
          ? 'flex gap-[10px]'
          : 'mt-[14px] flex gap-[10px] border-t border-dashed border-(--border-default) pt-[13px]'
      }
    >
      <span className="mono mt-[1px] flex h-5 w-5 flex-none items-center justify-center rounded-full bg-(--surface-active) text-[11px] text-(--text-secondary)">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-2 font-sans text-[12.5px] font-medium leading-[1.45] text-(--text-secondary)">{title}</div>
        {children}
      </div>
    </div>
  )
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
      {items.map((item) => (
        <li
          key={item}
          className="flex items-start gap-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)"
        >
          <span className="mt-[7px] h-1 w-1 flex-none rounded-full bg-(--text-tertiary)" />
          {item}
        </li>
      ))}
    </ul>
  )
}

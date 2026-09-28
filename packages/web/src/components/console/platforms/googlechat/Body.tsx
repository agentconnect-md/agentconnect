// No 'use client' here: rendered only inside ModalProvider's tree (the client boundary).

import { useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { IntegrationDto } from '@/lib/api'
import { credentialAttention, type Agent } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import type { WizardHost } from '../contract'
import { useDeploymentConfig } from '../deployment-config'
import { usePublishedFooter, usePublishedIdentityChrome } from '../publish'
import { googleChatApi } from './api'
import { CopyField } from './fields'
import { GoogleChatMark } from './mark'
import {
  GOOGLE_CHAT_AUDIENCE,
  GOOGLE_CHAT_CONFIG_URL,
  googleChatCallbackUrl,
  googleChatErrorMessage,
  googleChatSetupState,
  parseServiceAccountKey,
  projectNumberOk
} from './setup'

// Literal class strings, never assembled (STYLE.md §8).
const PRIMARY =
  'flex h-[46px] w-full items-center justify-center gap-[10px] rounded-[10px] border-0 bg-(--surface-inverse) font-sans text-[14px] font-semibold leading-normal text-white'

/** Which pane shows: a probe in flight, no relay to receive events, the own-app steps, or the test. */
export type GoogleChatPane = 'checking' | 'relay_required' | 'own' | 'test'

/** The pane for the wizard's current facts; pure so the step flow is testable without rendering. */
export function googleChatPane(input: { relayAvailable: boolean | null; created: boolean }): GoogleChatPane {
  if (input.created) return 'test'
  if (input.relayAvailable === null) return 'checking'
  return input.relayAvailable ? 'own' : 'relay_required'
}

/** Google Chat's pane (§3): an organization's own app, then a test where saved, connected and tested differ; the deployment app is claimed from Google Chat instead. */
export function GoogleChatWizardBody({ agent, host }: { agent: Agent; host: WizardHost }) {
  const t = useTranslations('Platforms.googlechat')
  const translate = (key: Parameters<typeof t>[0]) => t(key)
  // The chassis reads this same probe for its relay capability; only "has it answered" is read here.
  const probe = useDeploymentConfig(true)
  const { integrations, getAgent } = useConsoleData()

  const [projectId, setProjectId] = useState('')
  const [projectNumber, setProjectNumber] = useState('')
  const [serviceAccountKey, setServiceAccountKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<IntegrationDto | null>(null)
  // Synchronous re-entry guard; `saving` only commits on the next render.
  const busyRef = useRef(false)

  // An answer wins over a later error, as in the other relay-only panes.
  const relayAvailable: boolean | null = probe.config ? host.relayCapability.available : probe.failed ? false : null
  const pane = googleChatPane({ relayAvailable, created: !!created })
  const callbackUrl = googleChatCallbackUrl(host.relayCapability.publicUrl)

  const keyTrim = serviceAccountKey.trim()
  const parsedKey = keyTrim ? parseServiceAccountKey(keyTrim) : null
  const numberOk = projectNumberOk(projectNumber)
  const valid = !!projectId.trim() && numberOk && !!parsedKey

  const pasteKey = (value: string) => {
    setServiceAccountKey(value)
    // The key names its own project, which the form needs anyway.
    const fromKey = parseServiceAccountKey(value.trim())?.projectId
    if (fromKey && !projectId.trim()) setProjectId(fromKey)
  }

  const submit = async () => {
    if (busyRef.current || !valid) return
    busyRef.current = true
    setSaving(true)
    host.setError(null)
    const number = projectNumber.trim()
    try {
      const integration = await googleChatApi.create({
        platform: 'googlechat',
        agentId: agent.id,
        transport: 'http',
        googlechat: {
          projectId: projectId.trim(),
          ...(number ? { projectNumber: number } : {}),
          serviceAccountKey: keyTrim
        }
      })
      host.invalidate()
      setCreated(integration)
    } catch (e) {
      host.setError(googleChatErrorMessage(e, translate))
    } finally {
      // Write-only: the key leaves browser state once it has been submitted, whatever the answer.
      setServiceAccountKey('')
      setSaving(false)
      busyRef.current = false
    }
  }

  // Only the own-app steps use the host's identity chassis and footer; every other pane carries its own action.
  const own = pane === 'own'
  usePublishedIdentityChrome(host, { hidden: !own })
  usePublishedFooter(host, {
    label: saving ? t('footer.connecting') : t('footer.connect'),
    enabled: own && valid && !saving,
    onSubmit: () => void submit(),
    hidden: !own
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

  if (pane === 'test' && created) {
    const row = integrations.find((integration) => integration.id === created.id)
    const live = getAgent(agent.id) ?? agent
    const attention = row ? credentialAttention(row) : false
    const state = googleChatSetupState({
      saved: true,
      active: row ? !row.revoked : created.status === 'active',
      credentialAttention: attention,
      relayAvailable: host.relayCapability.available,
      agentReady: live.placementReady ?? live.status === 'online',
      conversations: row?.channels.length ?? created.channels.length
    })
    return (
      <Frame>
        <div className="mb-3 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
          {t('test.title')}
        </div>
        <ul className="flex flex-col gap-[10px]">
          <StateRow done={state.saved} label={t('test.saved')} detail={t('test.savedDone')} />
          <StateRow
            done={state.connected}
            label={t('test.connected')}
            detail={
              state.connected ? t('test.connectedDone') : attention ? t('errors.keyRejected') : t('test.waitingDaemon')
            }
          />
          <StateRow
            done={state.added}
            label={t('test.added')}
            detail={state.added ? t('test.addedDone') : t('test.addedPending')}
          />
        </ul>
        {/* The console cannot see the test itself: a DM session is private to its sender (§6). */}
        <p className="mt-[12px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
          {t('test.sendMessage')}
        </p>
        <div className="mt-[14px] flex flex-col gap-[6px] border-t border-dashed border-(--border-default) pt-[12px]">
          <Fact icon="lock">{t('test.dmPrivate')}</Fact>
          <Fact icon="users">{t('test.spacesOrg')}</Fact>
        </div>
        <button type="button" onClick={host.close} className={`${PRIMARY} mt-[14px] cursor-pointer`}>
          {t('test.done')}
        </button>
      </Frame>
    )
  }

  // Reusing a freed app is the host's own flow; this pane only creates.
  if (host.mode !== 'create') return null

  return (
    <div className="mb-4 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) p-[14px]">
      <Step n={1} title={t('prerequisites.title')} first>
        <ul className="flex flex-col gap-[5px]">
          {(['account', 'project', 'crm', 'serviceAccount'] as const).map((item) => (
            <li
              key={item}
              className="flex items-start gap-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)"
            >
              <span className="mt-[7px] h-1 w-1 flex-none rounded-full bg-(--text-tertiary)" />
              {t(`prerequisites.${item}`)}
            </li>
          ))}
        </ul>
      </Step>
      <Step n={2} title={t('configure.title')}>
        <a
          href={GOOGLE_CHAT_CONFIG_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mb-[10px] flex h-[38px] items-center justify-center gap-2 rounded-md bg-(--surface-inverse) font-sans text-[13px] font-semibold leading-normal text-white no-underline"
        >
          <span className="imark h-[18px] w-[18px] border-0 bg-transparent">
            <GoogleChatMark fillPct={100} />
          </span>
          {t('prerequisites.open')}
          <Icon name="external-link" size={14} />
        </a>
        <div className="flex flex-col gap-[10px]">
          {callbackUrl && <CopyField label={t('configure.endpoint')} value={callbackUrl} />}
          <CopyField label={t('configure.audience')} value={GOOGLE_CHAT_AUDIENCE} />
          <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
            <div className="fld">
              <span className="fldlbl">{t('configure.functionality')}</span>
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t('configure.receiveDms')}
              </span>
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t('configure.joinSpaces')}
              </span>
            </div>
            <div className="fld">
              <span className="fldlbl">{t('configure.visibility')}</span>
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t('configure.visibilityValue')}
              </span>
            </div>
          </div>
        </div>
      </Step>
      <Step n={3} title={t('credentials.title')}>
        <div className="grid grid-cols-1 gap-[10px] desktop:grid-cols-2">
          <label className="fld">
            <span className="fldlbl">{t('credentials.projectId')}</span>
            <input
              className="inp mn"
              placeholder={t('credentials.projectIdPlaceholder')}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">
              {t('credentials.projectNumber')}{' '}
              <span className="font-normal text-(--text-tertiary)">{t('credentials.optional')}</span>
            </span>
            <input
              className={`inp mn ${numberOk ? '' : 'border-(--status-error)'}`}
              placeholder="123456789012"
              inputMode="numeric"
              value={projectNumber}
              onChange={(e) => setProjectNumber(e.target.value)}
            />
          </label>
          <label className="fld desktop:col-span-2">
            <span className="fldlbl">{t('credentials.key')}</span>
            <input
              className={`inp mn ${keyTrim && !parsedKey ? 'border-(--status-error)' : ''}`}
              type="password"
              autoComplete="new-password"
              placeholder={t('credentials.keyPlaceholder')}
              value={serviceAccountKey}
              onChange={(e) => pasteKey(e.target.value)}
            />
          </label>
        </div>
      </Step>
    </div>
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

/** One of saved, connected and tested. */
function StateRow({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-[10px]" data-done={done}>
      <Icon
        name={done ? 'circle-check' : 'circle-dashed'}
        size={16}
        color={done ? 'var(--status-online)' : 'var(--text-tertiary)'}
        className="mt-[1px] flex-none"
      />
      <div className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-[1.5]">
        <div className="font-semibold text-(--text-primary)">{label}</div>
        <div className="text-(--text-tertiary)">{detail}</div>
      </div>
    </li>
  )
}

/** A consequence of the setup §6 requires stating: who can read which conversations. */
function Fact({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
      <Icon name={icon} size={14} color="var(--text-tertiary)" className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

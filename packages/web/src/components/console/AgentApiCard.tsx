'use client'

// The API card on an agent's Integrations tab: a row per added chat API, each with its Quickstart (shared-bot-relay.md §10.4).

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { ApiKeyFormModal, MY_KEYS, type ApiKeyOwner } from '@/components/console/ApiKeysCard'
import { MOCK_MODE, agentLabel, type Agent } from '@/lib/data'
import { useOrgs } from '@/lib/org-context'
import { useIsMobile } from '@/lib/use-is-mobile'
import { consoleKeys } from '@/lib/swr-keys'
import { agentApiRelayUrl, agentChatUrls, aiSdkProxySnippet, API_PROTOCOLS, apiProtocolLabel } from '@/lib/agent-api'
import { useOptionalDecisionsPrototype } from '@/lib/decisions/provider'
import type { SavedGate } from '@/lib/decisions/binding'
import { apiGateEvaluations } from '@/lib/decisions/evaluation-source'
import { DecisionBindingStrip, DecisionGateEntry } from '@/components/console/decisions/DecisionBindingStrip'
import type { ChannelDecisionGate } from '@agentconnect.md/protocol/decision'
import {
  cpRestBase,
  fetchMyApiKeys,
  fetchServiceAccounts,
  removeAgentApi,
  serviceAccountKeysApi,
  setAgentApiGate,
  type AgentApiEntryDto,
  type AgentApiProtocol,
  type ServiceAccountDto,
  type UserApiKeyDto
} from '@/lib/api'

const MOCK_RELAY_URL = 'https://relay.example.test'

export function AgentApiCard({
  agent,
  entries,
  mobile,
  divided = false,
  onChanged
}: {
  agent: Agent
  entries: AgentApiEntryDto[]
  mobile: boolean
  /** Mobile only: a rule above, when other integrations precede it. */
  divided?: boolean
  onChanged: () => void
}) {
  const t = useTranslations('Integrations.api')
  const [quickstart, setQuickstart] = useState<AgentApiProtocol | null>(null)
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const e of entries) await removeAgentApi(agent.id, e.protocol)
      setRemoving(false)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const removeButton = (
    <button
      className={mobile ? 'iconbtn h-7 w-7 flex-none' : 'iconbtn'}
      title={t('remove')}
      aria-label={t('remove')}
      onClick={() => setRemoving(true)}
    >
      <Icon name="unplug" size={mobile ? 14 : 15} />
    </button>
  )
  const rows = entries.map((e) => (
    <ApiRow
      key={e.protocol}
      agent={agent}
      entry={e}
      mobile={mobile}
      onQuickstart={() => setQuickstart(e.protocol)}
      onChanged={onChanged}
    />
  ))
  const dialogs = (
    <>
      {quickstart && <QuickstartDialog agent={agent} protocol={quickstart} onClose={() => setQuickstart(null)} />}
      {removing && (
        <ConfirmationDialog
          title={t('removeTitle')}
          confirmLabel={t('removeConfirm')}
          busy={busy}
          busyLabel={t('removing')}
          error={error}
          destructive
          onConfirm={() => void remove()}
          onClose={() => setRemoving(false)}
        >
          {t('removeBody', { agent: agentLabel(agent) })}
        </ConfirmationDialog>
      )}
    </>
  )

  if (mobile) {
    return (
      <div className={divided ? 'border-t border-(--border-subtle)' : undefined}>
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
            <Icon name="code-xml" size={17} color="var(--text-secondary)" />
          </span>
          <span className="min-w-0 flex-1 font-sans text-[14px] font-semibold leading-normal">{t('title')}</span>
          {removeButton}
        </div>
        {rows}
        {dialogs}
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-[9px] border border-(--border-subtle)">
      <div className="flex items-center gap-3 px-[14px] py-3">
        <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name="code-xml" size={16} color="var(--text-secondary)" />
        </span>
        <span className="min-w-0 flex-1 font-sans text-[13.5px] font-semibold leading-normal">{t('title')}</span>
        {removeButton}
      </div>
      {rows}
      {dialogs}
    </div>
  )
}

/** One protocol: its Decision gate (the same `+ Decision` and rules as a channel's By decision) and its Quickstart. */
function ApiRow({
  agent,
  entry,
  mobile,
  onQuickstart,
  onChanged
}: {
  agent: Agent
  entry: AgentApiEntryDto
  mobile: boolean
  onQuickstart: () => void
  onChanged: () => void
}) {
  const t = useTranslations('Integrations.api')
  const decisions = useOptionalDecisionsPrototype()
  const { activeOrg } = useOrgs()
  const bindingKey = `api:${activeOrg?.id ?? ''}:${agent.id}:${entry.protocol}`
  const saved: SavedGate | null = entry.gate ? (({ type: _type, ...gate }) => gate)(entry.gate) : null
  const saveGate = async (gate: ChannelDecisionGate | null) => {
    await setAgentApiGate(agent.id, entry.protocol, gate)
    onChanged()
  }
  const padX = mobile ? 16 : 14
  // Agent detail mounts a mobile and a desktop card; only the visible one owns the strip, so its dialog portals once.
  const ownsStrip = useIsMobile() === mobile
  return (
    <>
      <div
        className={`flex items-center gap-[10px] border-t border-(--border-subtle) py-[9px] ${mobile ? 'px-4' : 'px-[14px]'}`}
      >
        <Icon name="code-xml" size={14} color="var(--text-tertiary)" className="flex-none" />
        <span className="mono min-w-0 flex-1 truncate text-[12px]">{apiProtocolLabel(entry.protocol)}</span>
        {decisions && (
          <DecisionGateEntry
            bindingKey={bindingKey}
            saved={saved}
            canWrite={agent.canEdit}
            offer
            onStop={() => saveGate(null)}
          />
        )}
        <Button variant="secondary" size="xs" onClick={onQuickstart}>
          <Icon name="code-xml" size={13} color="var(--text-tertiary)" />
          {t('quickstart')}
        </Button>
      </div>
      {decisions && ownsStrip && (saved || decisions.bindingDrafts[bindingKey]) && (
        <DecisionBindingStrip
          bindingKey={bindingKey}
          conversation={null}
          canWrite={agent.canEdit}
          agentName={agentLabel(agent)}
          channelName={apiProtocolLabel(entry.protocol)}
          padX={padX}
          saved={saved}
          status={saved ? 'ready' : null}
          surface="api"
          // Only those who can edit the agent read the calls its gate judged.
          {...(agent.canEdit
            ? { evaluations: apiGateEvaluations(decisions.api, decisions.orgId, agent.id, entry.protocol) }
            : {})}
          onSave={(gate) => saveGate(gate)}
        />
      )}
    </>
  )
}

interface ChatKey {
  key: UserApiKeyDto
  owner: ServiceAccountDto | null
}

const reachesAgent = (k: UserApiKeyDto, orgId: string, agentId: string) =>
  k.orgId === orgId &&
  k.permission === 'agent:chat' &&
  !k.revokedAt &&
  !(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) &&
  (k.allAgents || k.agentIds.includes(agentId))

function QuickstartDialog({
  agent,
  protocol,
  onClose
}: {
  agent: Agent
  protocol: AgentApiProtocol
  onClose: () => void
}) {
  const t = useTranslations('Integrations.api')
  const { activeOrg } = useOrgs()
  const orgId = activeOrg?.id ?? ''
  // Service accounts and their keys are owner-managed, so only an owner is offered them.
  const owner = activeOrg?.role === 'owner'
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  const { data: accounts } = useSWR<ServiceAccountDto[]>(
    owner && !MOCK_MODE ? consoleKeys.serviceAccounts(orgId) : null,
    () => fetchServiceAccounts(orgId)
  )
  const accountsReady = !owner || MOCK_MODE || accounts !== undefined
  const keysKey = consoleKeys.agentChatKeys(orgId, owner)
  const { data: chatKeys, mutate } = useSWR<ChatKey[]>(
    accountsReady && !MOCK_MODE && keysKey ? [...keysKey, (accounts ?? []).map((a) => a.userId).join(',')] : null,
    async () => {
      const mine = (await fetchMyApiKeys()).map((key) => ({ key, owner: null }))
      const theirs = await Promise.all(
        (accounts ?? []).map(async (a) =>
          (await serviceAccountKeysApi(orgId, a.userId).list()).map((key) => ({ key, owner: a }))
        )
      )
      return [...mine, ...theirs.flat()]
    }
  )
  const keys = (chatKeys ?? []).filter((k) => reachesAgent(k.key, orgId, agent.id))

  const owners: ApiKeyOwner[] = [
    { id: 'me', label: t('me'), serviceAccount: false, source: MY_KEYS },
    ...(accounts ?? []).map((a) => ({
      id: a.userId,
      label: a.displayName,
      serviceAccount: true,
      source: {
        swrKey: consoleKeys.serviceAccountKeys(orgId, a.userId),
        ...serviceAccountKeysApi(orgId, a.userId),
        serviceAccount: true
      }
    }))
  ]

  const urls = agentChatUrls(
    cpRestBase(),
    orgId,
    agent.id,
    agentApiRelayUrl() ?? (MOCK_MODE ? MOCK_RELAY_URL : undefined)
  )
  const snippet = aiSdkProxySnippet(urls.mintUrl)
  const docsUrl = API_PROTOCOLS.find((p) => p.id === protocol)?.docsUrl
  const copy = async (what: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      /* clipboard unavailable (insecure context) — the text stays selectable */
    }
  }

  if (creating) {
    return (
      <div className="scrim">
        <div className="modal">
          <ApiKeyFormModal
            source={MY_KEYS}
            orgs={activeOrg ? [activeOrg] : []}
            defaultOrgId={orgId}
            owners={owners}
            defaultPermission="agent:chat"
            defaultAgentIds={[agent.id]}
            onClose={() => setCreating(false)}
            onSaved={() => void mutate()}
          />
        </div>
      </div>
    )
  }

  const endpoint = (label: string, url: string) => (
    <div className="flex items-center gap-2 rounded-[9px] border border-(--border-default) bg-(--surface-card) py-[6px] pr-[6px] pl-3">
      <span className="mono flex-none rounded bg-(--surface-active) px-[7px] py-[2px] text-[11px] font-semibold text-(--text-secondary)">
        POST
      </span>
      <span className="mono min-w-0 flex-1 truncate text-[12.5px]" title={url}>
        {url}
      </span>
      <button className="iconbtn flex-none" title={t('copy')} aria-label={label} onClick={() => void copy(label, url)}>
        <Icon name={copied === label ? 'check' : 'copy'} size={14} />
      </button>
    </div>
  )

  return (
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-label={t('quickstart')}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="code-xml" size={16} color="var(--brand)" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-sans text-[16px] font-semibold leading-normal">{t('quickstart')}</div>
            <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {apiProtocolLabel(protocol)} · {agentLabel(agent)}
            </div>
          </div>
          {docsUrl && (
            <a className="lnk flex-none text-[12px]" href={docsUrl} target="_blank" rel="noopener noreferrer">
              {t('docs')}
              <Icon name="arrow-up-right" size={12} />
            </a>
          )}
          <button className="iconbtn" aria-label={t('close')} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="fldlbl">{t('mintEndpoint')}</span>
            {endpoint(t('mintEndpoint'), urls.mintUrl)}
            {urls.chatTemplate && (
              <>
                <span className="fldlbl mt-1">{t('chatEndpoint')}</span>
                {endpoint(t('chatEndpoint'), urls.chatTemplate)}
              </>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="fldlbl">useChat</span>
              <button
                className="iconbtn"
                title={t('copy')}
                aria-label={t('copySnippet')}
                onClick={() => void copy('snippet', snippet)}
              >
                <Icon name={copied === 'snippet' ? 'check' : 'copy'} size={14} />
              </button>
            </div>
            <pre className="codedark m-0 overflow-x-auto whitespace-pre">{snippet}</pre>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="fldlbl">{t('keys')}</span>
              <Button variant="secondary" size="xs" onClick={() => setCreating(true)}>
                <Icon name="plus" size={13} />
                {t('createKey')}
              </Button>
            </div>
            <div className="overflow-hidden rounded-md border border-(--border-subtle)">
              {keys.length === 0 ? (
                <div className="px-3 py-[9px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
                  {chatKeys === undefined && !MOCK_MODE ? t('keysLoading') : t('noKeys')}
                </div>
              ) : (
                keys.map(({ key, owner: account }) => (
                  <div
                    key={key.id}
                    className="flex items-center gap-[10px] border-b border-(--border-subtle) px-3 py-[8px] last:border-b-0"
                  >
                    <Icon name="key" size={13} color="var(--text-tertiary)" className="flex-none" />
                    <span className="min-w-0 truncate font-sans text-[12.5px] font-medium leading-normal">
                      {key.name ?? key.displayTail}
                    </span>
                    <span className="mono flex-none text-[11.5px] text-(--text-tertiary)">{key.displayTail}</span>
                    <span className="min-w-0 flex-1 truncate text-right font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {account ? account.displayName : t('me')} · {key.allAgents ? t('allAgents') : agentLabel(agent)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="primary" onClick={onClose}>
            {t('done')}
          </Button>
        </div>
      </div>
    </div>
  )
}

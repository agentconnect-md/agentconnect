'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  fetchAgentDto,
  fetchAgentMcpToolPolicies,
  type AgentMcpToolPoliciesDto,
  type AgentMcpToolPolicyDto,
  type McpProviderCreatedDto,
  type McpProviderDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { MOCK_MODE, type DaemonRow } from '@/lib/data'
import { mcpCandidates, mcpCapsFor, mcpKindLabel, mcpServersForRuntime } from '@/components/console/McpServersField'
import { AttachedEmpty, AttachedNote, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { ConnectorsModal } from '@/components/console/ConnectorsModal'
import { CreateMcpProviderModal, EditConnectorModal, EditMcpProviderModal } from '@/components/console/McpServersCard'
import { ProviderMark, useConnectorIcons } from '@/components/console/ToolTile'
import { Scrim } from '@/components/console/Scrim'
import { McpToolPermissionsPanel } from '@/components/console/McpToolPermissionsPanel'
import { Icon } from '@/components/ui'

/** The agent's attached MCP servers (the saved `mcpServers` allow-list, stale names dimmed so they can be removed), the Add menu, and each registry server's tool permissions. */
export function AgentToolsCard({
  agentId,
  runtime,
  daemon,
  canEdit,
  onBusyChange
}: {
  agentId: string
  runtime: string
  daemon: DaemonRow | undefined
  canEdit: boolean
  /** Reports a write in flight, so a host dialog can hold its own completion until the row settles. */
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useTranslations('Agents.detail.tools')
  const tp = useTranslations('Agents.detail.toolPermissions')
  const { updateAgent, mcpProviders, connectorsEnabled, daemons } = useConsoleData()
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [editing, setEditing] = useState<McpProviderDto | null>(null)
  // Candidate list = daemon-configured servers ∪ org-registry provider names, gated
  // by the runtime's transport support (registry providers are http-proxied).
  const registryNames = useMemo(() => mcpProviders.map((p) => p.name), [mcpProviders])
  // Same catalog icons the registry card's tiles use, keyed here by provider NAME
  // (that's all a candidate row carries). Names off the registry get the plug glyph.
  const serviceByName = useMemo(
    () => new Map(mcpProviders.flatMap((p) => (p.service ? [[p.name, p.service] as const] : []))),
    [mcpProviders]
  )
  // The registry row behind a candidate name (when there is one) — it carries the
  // kind wording, so an agent row says the same thing about a server as its
  // registry tile does.
  const providerByName = useMemo(() => new Map(mcpProviders.map((p) => [p.name, p] as const)), [mcpProviders])
  const iconByService = useConnectorIcons(connectorsEnabled && serviceByName.size > 0)
  const iconFor = (name: string) => {
    const service = serviceByName.get(name)
    return service ? iconByService.get(service) : undefined
  }
  // The registry half is org-scoped and http-proxied, so it does NOT depend on resolving an
  // owning daemon: a pool- or group-placed agent carries a placement sentinel rather than a
  // member id, and gating the whole list on that lookup hid every org server it could attach.
  const candidates = mcpCandidates(daemon?.mcpServers ?? [], registryNames)
  const caps = daemon ? mcpCapsFor(daemon.runtimeModels, runtime) : null
  const servers = mcpServersForRuntime(candidates, caps)
  // The persisted allow-list, once the raw spec loads; null ⇒ not loaded yet.
  const [enabled, setEnabled] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    onBusyChange?.(saving)
  }, [saving, onBusyChange])
  const fetched = useRef(false)
  // Per-provider tool policies; null until read, or when this CP predates them.
  const [toolPolicies, setToolPolicies] = useState<AgentMcpToolPoliciesDto | null>(null)
  const [permissionsFor, setPermissionsFor] = useState<McpProviderDto | null>(null)
  const loadToolPolicies = useCallback(() => {
    fetchAgentMcpToolPolicies(agentId).then(setToolPolicies, () => setToolPolicies(null))
  }, [agentId])

  // The saved allow-list is read even with nothing eligible, so stale names stay removable.
  useEffect(() => {
    if (fetched.current) return
    // Only demo agents lack a spec; a real agent the caller cannot edit is still view-gated readable.
    if (!canEdit && MOCK_MODE) {
      setEnabled(['grafana', 'linear'])
      return
    }
    fetched.current = true
    fetchAgentDto(agentId).then(
      (dto) => setEnabled(dto.mcpServers ?? []),
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
    loadToolPolicies()
  }, [agentId, canEdit, loadToolPolicies])

  const attach = async (name: string, next: boolean) => {
    if (!canEdit || enabled === null || saving) return
    const prev = enabled
    const nextEnabled = next ? [...enabled.filter((n) => n !== name), name] : enabled.filter((n) => n !== name)
    setEnabled(nextEnabled)
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agentId, { mcpServers: nextEnabled })
    } catch (e) {
      setEnabled(prev) // revert on failure so the card never lies about what's saved
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // A server registered from this card — by URL, or as a connector connection — is
  // what the operator wanted on THIS agent, so it is attached as soon as the registry
  // accepts it, with no second trip through the Add menu. Its name is the allow-list
  // key, exactly as a registry candidate's is.
  const attachCreated = (created: McpProviderCreatedDto) => void attach(created.name, true)

  const attached = enabled ?? []
  const eligible = new Map(servers.map((s) => [s.name, s] as const))
  const candidateNames = new Set(candidates.map((c) => c.name))
  const options = servers
    .filter((s) => !attached.includes(s.name))
    .map((s) => ({
      key: s.name,
      name: s.name,
      meta: mcpKindLabel(providerByName.get(s.name)?.kind),
      onPick: () => void attach(s.name, true)
    }))
  // Why a saved name isn't attachable any more: reported but transport-ineligible,
  // or no longer reported at all.
  const staleMeta = (n: string) =>
    candidateNames.has(n) ? 'Not supported by this runtime' : 'Not available to this agent'

  const menu = canEdit ? (
    <AttachMenu
      ariaLabel={t('addCustomMcp')}
      disabled={enabled === null || saving}
      groups={[
        {
          heading: t('addExisting'),
          icon: 'plug',
          options,
          emptyLabel: 'Every server available to this agent is already attached.'
        }
      ]}
      actions={[
        ...(connectorsEnabled
          ? [{ key: 'connectors', label: t('browseConnectors'), icon: 'blocks', onPick: () => setBrowsing(true) }]
          : []),
        { key: 'custom', label: t('addCustomMcp'), icon: 'plus', onPick: () => setCreating(true) }
      ]}
    />
  ) : undefined

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">{t('tools')}</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">
          {t('mcpServers')}
          {daemon ? ` · ${runtime} on ${daemon.name}` : ` · ${runtime}`}
        </span>
        {menu}
      </div>

      {attached.length > 0 ? (
        <>
          <div>
            {attached.map((name) => {
              const server = eligible.get(name)
              const provider = providerByName.get(name)
              return (
                <AttachedRow
                  key={name}
                  mark={<ProviderMark iconUrl={iconFor(name)} />}
                  name={name}
                  meta={
                    server
                      ? `${server.transport} · ${mcpKindLabel(provider?.kind)}`
                      : `${mcpKindLabel(provider?.kind)} · ${staleMeta(name)}`
                  }
                  dimmed={!server}
                  // Registry servers open the same dialog their registry tile does; daemon-local ones have no CP config to edit.
                  onOpen={provider?.canEdit ? () => setEditing(provider) : undefined}
                  openTitle={t('editServer')}
                  badge={
                    <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
                      {provider ? t('workspace') : t('daemon')}
                    </span>
                  }
                  onRemove={canEdit && !saving ? () => void attach(name, false) : undefined}
                  removeTitle={t('removeFromAgent')}
                >
                  {provider && toolPolicies && (
                    <ToolPermissionsLine
                      policy={toolPolicies.policies.find((p) => p.providerId === provider.id) ?? null}
                      onEdit={canEdit ? () => setPermissionsFor(provider) : undefined}
                    />
                  )}
                </AttachedRow>
              )
            })}
          </div>
          <AttachedNote>
            {daemon
              ? t.rich('servedByRuntimeOnDaemon', {
                  runtime,
                  daemon: () => <span className="mono text-[11.5px]">{daemon.name}</span>
                })
              : t('servedByRuntime', { runtime })}
          </AttachedNote>
        </>
      ) : (
        <AttachedEmpty
          // `enabled` null ⇒ the saved allow-list is still in flight; claiming
          // "no servers" then would be a guess, not a fact.
          title={enabled === null ? t('loading') : t('noMcpServers')}
          hint={enabled === null ? t('readingAttachedServers') : canEdit ? t('attachMcpHint') : t('noAttachedServers')}
          action={enabled === null ? undefined : menu}
        />
      )}

      {err && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {err}
        </div>
      )}

      {creating && (
        <Scrim onEscape={() => setCreating(false)}>
          <div className="modal">
            <CreateMcpProviderModal onClose={() => setCreating(false)} onCreated={attachCreated} />
          </div>
        </Scrim>
      )}
      {editing && (
        <Scrim onEscape={() => setEditing(null)}>
          <div className="modal">
            {editing.kind === 'open_connector' ? (
              <EditConnectorModal provider={editing} onClose={() => setEditing(null)} />
            ) : (
              <EditMcpProviderModal provider={editing} onClose={() => setEditing(null)} />
            )}
          </div>
        </Scrim>
      )}
      {permissionsFor && toolPolicies && (
        <Scrim onEscape={() => setPermissionsFor(null)}>
          <div className="modal max-w-[720px]" role="dialog" aria-label={tp('title')}>
            <McpToolPermissionsPanel
              agentId={agentId}
              providerId={permissionsFor.id}
              providerName={permissionsFor.name}
              policy={toolPolicies.policies.find((p) => p.providerId === permissionsFor.id) ?? null}
              compatibility={{
                daemonsWithoutAgentDefinitions: toolPolicies.compatibility.daemonsWithoutAgentDefinitions.map(
                  (id) => daemons.find((d) => d.daemonId === id)?.name ?? id
                ),
                relaysWithoutToolPolicies: toolPolicies.compatibility.relaysWithoutToolPolicies
              }}
              onClose={() => setPermissionsFor(null)}
              onSaved={loadToolPolicies}
            />
          </div>
        </Scrim>
      )}
      {browsing && (
        <Scrim onEscape={() => setBrowsing(false)}>
          <div className="modal max-w-[920px]">
            <ConnectorsModal onClose={() => setBrowsing(false)} onCreated={attachCreated} />
          </div>
        </Scrim>
      )}
    </div>
  )
}

/** A registry server's tool permissions under its attached row: Full access or Restricted with per-decision counts. */
function ToolPermissionsLine({ policy, onEdit }: { policy: AgentMcpToolPolicyDto | null; onEdit?: () => void }) {
  const t = useTranslations('Agents.detail.toolPermissions')
  const summary = policy
    ? [
        t('summaryAllowed', { count: policy.allowTools.length }),
        ...(policy.approvalTools.length > 0 ? [t('summaryApproval', { count: policy.approvalTools.length })] : []),
        ...(policy.askTools.length > 0 ? [t('summaryAsk', { count: policy.askTools.length })] : []),
        t('summaryRestBlocked')
      ].join(' · ')
    : t('summaryFull')
  return (
    <div
      data-testid="tool-permissions-line"
      className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pr-4 pb-3 pl-[57px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
    >
      <Icon name="shield-check" size={13} className="flex-none" />
      <span
        className={
          policy
            ? 'badge flex-none bg-(--brand-soft) text-(--brand-soft-text)'
            : 'badge flex-none bg-(--surface-active) text-(--text-secondary)'
        }
      >
        {policy ? t('restricted') : t('presets.full')}
      </span>
      <span className="min-w-0">{summary}</span>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="ml-auto cursor-pointer border-0 bg-transparent p-0 font-sans text-[12px] font-medium leading-normal text-(--text-link) hover:underline"
        >
          {t('edit')}
        </button>
      )}
    </div>
  )
}

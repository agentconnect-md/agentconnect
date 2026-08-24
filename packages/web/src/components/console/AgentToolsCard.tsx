'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchAgentDto, type McpProviderCreatedDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { MOCK_MODE, type DaemonRow } from '@/lib/data'
import { mcpCandidates, mcpCapsFor, mcpKindLabel, mcpServersForRuntime } from '@/components/console/McpServersField'
import { AttachedEmpty, AttachedNote, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { ConnectorsModal } from '@/components/console/ConnectorsModal'
import { CreateMcpProviderModal } from '@/components/console/McpServersCard'
import { ProviderMark, useConnectorIcons } from '@/components/console/ToolTile'

/**
 * Leads the agent's Tools & Skills tab: the MCP servers this agent has attached,
 * one row each, plus the header's Add menu offering the ones it hasn't (via
 * `mcpServersForRuntime`/`mcpKindLabel`). MCP is agent-scoped — this is the
 * surface where it's picked; the daemon detail view no longer lists MCP servers.
 *
 * The agent model stores an explicit allow-list (`mcpServers`) and the daemon
 * attaches ONLY the names in it (an empty list ⇒ no servers), so the rows ARE the
 * saved list — attaching appends a name, the row's × removes it, and both persist
 * through `updateAgent`. Saved names the daemon no longer reports — or whose
 * transport the current runtime can't attach — still render as dimmed rows so they
 * can be removed (they are never offered in the Add menu); this is the only place
 * to clear a stale name.
 *
 * The Add menu's quick-add items open the org registry's OWN dialogs
 * (`CreateMcpProviderModal`, `ConnectorsModal`) rather than a second create form,
 * and a server created through the first is attached to this agent immediately.
 *
 * Daemons are live-only, so an agent with no resolved daemon — a mock one, one
 * out of the fleet, or one placed on a pool or a group rather than a member —
 * contributes no daemon-reported servers. The org registry still does.
 */
export function AgentToolsCard({
  agentId,
  runtime,
  daemon,
  canEdit
}: {
  agentId: string
  runtime: string
  daemon: DaemonRow | undefined
  canEdit: boolean
}) {
  const { updateAgent, mcpProviders, connectorsEnabled } = useConsoleData()
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
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
  const fetched = useRef(false)

  // Always fetch the saved allow-list (even with no eligible servers) so saved
  // names the daemon no longer reports — or whose transport the current runtime
  // can't attach — can still be shown and removed; without it a consolidated
  // Tools card offers no way to clear a stale name. Mock agents (canEdit false)
  // have no spec to fetch.
  useEffect(() => {
    if (fetched.current) return
    // Demo agents (canEdit false) have no spec to fetch — mock mode seeds a plausible
    // saved set instead so the card isn't uniformly empty.
    if (!canEdit) {
      if (MOCK_MODE) setEnabled(['grafana', 'linear'])
      return
    }
    fetched.current = true
    fetchAgentDto(agentId).then(
      // The saved allow-list IS the effective set (empty ⇒ no servers), so the
      // rows mirror it 1:1 rather than defaulting an empty list to all-on.
      (dto) => setEnabled(dto.mcpServers ?? []),
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
  }, [agentId, canEdit])

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

  // A server registered from this card is what the operator wanted on THIS agent,
  // so it is attached as soon as the registry accepts it — no second trip through
  // the Add menu. Its name is the allow-list key, exactly as a registry candidate's is.
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
      ariaLabel="Add an MCP server to this agent"
      disabled={enabled === null || saving}
      groups={[
        {
          heading: 'Add existing',
          icon: 'plug',
          options,
          emptyLabel: 'Every server available to this agent is already attached.'
        }
      ]}
      actions={[
        ...(connectorsEnabled
          ? [{ key: 'connectors', label: 'Browse connectors…', icon: 'blocks', onPick: () => setBrowsing(true) }]
          : []),
        { key: 'custom', label: 'Add custom MCP server…', icon: 'plus', onPick: () => setCreating(true) }
      ]}
    />
  ) : undefined

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">Tools</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">
          MCP servers{daemon ? ` · ${runtime} on ${daemon.name}` : ` · ${runtime}`}
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
                  badge={
                    <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">
                      {provider ? 'workspace' : 'daemon'}
                    </span>
                  }
                  onRemove={canEdit && !saving ? () => void attach(name, false) : undefined}
                  removeTitle="Remove from this agent"
                />
              )
            })}
          </div>
          <AttachedNote>
            Served by the {runtime} runtime
            {daemon ? (
              <>
                {' '}
                on <span className="mono text-[11.5px]">{daemon.name}</span>
              </>
            ) : null}
            . Removing a server hides its tools from this agent.
          </AttachedNote>
        </>
      ) : (
        <AttachedEmpty
          // `enabled` null ⇒ the saved allow-list is still in flight; claiming
          // "no servers" then would be a guess, not a fact.
          title={enabled === null ? 'Loading tools…' : 'No MCP servers'}
          hint={
            enabled === null
              ? 'Reading the servers this agent attaches.'
              : canEdit
                ? 'Attach one from your workspace, or register a new server.'
                : 'This agent has no MCP servers attached.'
          }
          action={enabled === null ? undefined : menu}
        />
      )}

      {err && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {err}
        </div>
      )}

      {creating && (
        <div className="scrim">
          <div className="modal">
            <CreateMcpProviderModal onClose={() => setCreating(false)} onCreated={attachCreated} />
          </div>
        </div>
      )}
      {browsing && (
        <div className="scrim">
          <div className="modal max-w-[920px]">
            <ConnectorsModal onClose={() => setBrowsing(false)} />
          </div>
        </div>
      )}
    </div>
  )
}

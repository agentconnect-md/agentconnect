'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchAgentDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import type { DaemonRow } from '@/lib/data'
import { mcpCandidates, mcpCapsFor, mcpServerMeta, mcpServersForRuntime } from '@/components/console/McpServersField'
import { Icon, Toggle } from '@/components/ui'

/**
 * Leads the agent's Knowledge & Tools tab: the MCP servers the owning daemon's
 * runtime can attach (via `mcpServersForRuntime`/`mcpServerMeta`), each with an
 * enable/disable toggle. MCP is agent-scoped — this is the surface where it's
 * picked; the daemon detail view no longer lists MCP servers.
 *
 * The agent model stores an explicit allow-list (`mcpServers`) and the daemon
 * attaches ONLY the names in it (an empty list ⇒ no servers), so the toggles
 * mirror the saved list 1:1 — a server is on iff its name is saved, and a brand
 * new agent (empty list) starts with every server OFF. Each toggle persists the
 * explicit set via `updateAgent`, so what's shown is exactly what a session
 * attaches. Saved names the daemon no longer reports — or whose transport the
 * current runtime can't attach — still render as rows so they can be turned OFF
 * (they can't be turned back on here); this is the only place to clear a stale
 * name now that the create/edit picker is gone.
 *
 * Daemons are live-only, so a mock agent (or one whose daemon is out of the fleet)
 * has no reported servers and renders the empty state.
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
  const { updateAgent, mcpProviders } = useConsoleData()
  // Candidate list = daemon-configured servers ∪ org-registry provider names, gated
  // by the runtime's transport support (registry providers are http-proxied).
  const registryNames = useMemo(() => mcpProviders.map((p) => p.name), [mcpProviders])
  const candidates = daemon ? mcpCandidates(daemon.mcpServers, registryNames) : []
  const caps = daemon ? mcpCapsFor(daemon.runtimeModels, runtime) : null
  const servers = mcpServersForRuntime(candidates, caps)
  // The persisted allow-list, once the raw spec loads; null ⇒ not loaded yet.
  const [enabled, setEnabled] = useState<string[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fetched = useRef(false)

  // Always fetch the saved allow-list (even with no eligible servers) so saved
  // names the daemon no longer reports — or whose transport the current runtime
  // can't attach — can still be shown and turned OFF; without it a consolidated
  // Tools card offers no way to clear a stale name. Mock agents (canEdit false)
  // have no spec to fetch.
  useEffect(() => {
    if (fetched.current || !canEdit) return
    fetched.current = true
    fetchAgentDto(agentId).then(
      // The saved allow-list IS the effective set (empty ⇒ no servers), so the
      // toggles mirror it 1:1 rather than defaulting an empty list to all-on.
      (dto) => setEnabled(dto.mcpServers ?? []),
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
  }, [agentId, canEdit])

  const toggle = async (name: string, next: boolean) => {
    if (!canEdit || enabled === null || saving) return
    const prev = enabled
    const nextEnabled = next ? [...enabled, name] : enabled.filter((n) => n !== name)
    setEnabled(nextEnabled)
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agentId, { mcpServers: nextEnabled })
    } catch (e) {
      setEnabled(prev) // revert on failure so the toggle never lies about what's saved
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  // Saved names not in the eligible set: reported-but-transport-ineligible, or no
  // longer reported at all. Shown so they can be turned off (never back on here).
  const eligibleNames = new Set(servers.map((s) => s.name))
  const candidateNames = new Set(candidates.map((c) => c.name))
  const unknown = (enabled ?? []).filter((n) => !eligibleNames.has(n))
  const unknownMeta = (n: string) =>
    candidateNames.has(n) ? 'Not supported by this runtime' : 'Not reported by this daemon'

  // One MCP row. Eligible servers toggle freely; an ineligible saved name stays
  // interactive only while ON, so it can be turned off but not re-enabled here.
  const row = (name: string, meta: string, eligible: boolean) => {
    const on = enabled ? enabled.includes(name) : false // mirror the saved set; off until it loads
    const interactive = canEdit && enabled !== null && !saving && (eligible || on)
    return (
      <div
        key={name}
        className="flex items-center gap-[11px] border-t border-(--border-subtle) px-4 py-[11px] first:border-t-0 desktop:py-3"
      >
        <Icon name="plug" size={16} color="var(--text-tertiary)" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12.5px] font-medium leading-normal text-(--text-primary)">
            {name}
          </div>
          <div className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {meta}
          </div>
        </div>
        <Toggle checked={on} disabled={!interactive} onChange={(next) => toggle(name, next)} />
      </div>
    )
  }

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="flex items-center justify-between border-b border-(--border-subtle) px-4 py-3 desktop:py-[13px]">
        <span className="font-sans text-[14px] font-semibold leading-normal">Tools</span>
        <span className="mono text-[11px] text-(--text-tertiary)">MCP servers · attached at session start</span>
      </div>
      {servers.length > 0 || unknown.length > 0 ? (
        <div>
          {servers.map((s) => row(s.name, mcpServerMeta(s), true))}
          {unknown.map((n) => row(n, unknownMeta(n), false))}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-[13px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:py-3">
          <Icon name="plug" size={14} />
          No MCP servers on this daemon&apos;s runtime.
        </div>
      )}
      {err && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {err}
        </div>
      )}
    </div>
  )
}

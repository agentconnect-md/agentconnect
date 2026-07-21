'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchAgentDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { Icon, Toggle } from '@/components/ui'

/**
 * The agent's shared-skills enable-list (docs/designs/shared-skills.md). Lists the
 * org's visible skill sources, each with an enable/disable toggle. The agent stores
 * an explicit list of "<source>/<skill>" / "<source>/*" entries; this card toggles a
 * whole source on/off as "<source>/*" (the source's own skill filter then decides
 * exactly which skills install). Per-skill toggles within a source are a later
 * refinement — the data model already supports them.
 *
 * A source enabled on the agent but no longer in the org registry still renders so
 * it can be turned OFF (never back on here), mirroring the MCP tools card.
 */
export function AgentSkillsCard({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const { updateAgent, skillSources } = useConsoleData()
  const [enabled, setEnabled] = useState<string[] | null>(null) // saved "<source>/*" list; null ⇒ not loaded
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fetched = useRef(false)

  useEffect(() => {
    if (fetched.current || !canEdit) return
    fetched.current = true
    fetchAgentDto(agentId).then(
      (dto) => setEnabled(dto.skills ?? []),
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
  }, [agentId, canEdit])

  // A source counts as enabled when any saved entry references its name.
  const sourceOf = (ref: string) => (ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : ref)
  const isOn = (name: string) => (enabled ?? []).some((ref) => sourceOf(ref) === name)

  const toggle = async (name: string, next: boolean) => {
    if (!canEdit || enabled === null || saving) return
    const prev = enabled
    // Drop every entry for this source, then re-add the whole-source wildcard when enabling.
    const without = enabled.filter((ref) => sourceOf(ref) !== name)
    const nextEnabled = next ? [...without, `${name}/*`] : without
    setEnabled(nextEnabled)
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agentId, { skills: nextEnabled })
    } catch (e) {
      setEnabled(prev)
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const known = new Set(skillSources.map((s) => s.name))
  const orphaned = (enabled ?? []).map(sourceOf).filter((n, i, a) => !known.has(n) && a.indexOf(n) === i)

  const row = (name: string, meta: string, eligible: boolean) => {
    const on = isOn(name)
    const interactive = canEdit && enabled !== null && !saving && (eligible || on)
    return (
      <div
        key={name}
        className="flex items-center gap-[11px] border-t border-(--border-subtle) px-4 py-[11px] first:border-t-0 desktop:py-3"
      >
        <Icon name="book-open" size={16} color="var(--text-tertiary)" />
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
        <span className="font-sans text-[14px] font-semibold leading-normal">Skills</span>
        <span className="mono text-[11px] text-(--text-tertiary)">installed via npx skills · before session start</span>
      </div>
      {skillSources.length > 0 || orphaned.length > 0 ? (
        <div>
          {skillSources.map((s) => row(s.name, s.source, true))}
          {orphaned.map((n) => row(n, 'No longer in the org registry', false))}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-[13px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:py-3">
          <Icon name="book-open" size={14} />
          No skill sources in your organization yet.
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

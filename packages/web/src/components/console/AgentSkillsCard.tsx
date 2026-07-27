'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchAgentDto, fetchSkillSourceSkills, type SkillSourceSkillsDto } from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { MOCK_MODE } from '@/lib/data'
import { SkillMark, SkillSourceLine, ToolTile, ToolTileGrid } from '@/components/console/ToolTile'
import { Icon, Toggle } from '@/components/ui'

/**
 * The agent's shared-skills enable-list (docs/designs/shared-skills.md). Lists the
 * org's visible skill sources; each can be enabled whole (`<source>/*`) or, when the
 * source's SKILL.md manifest is scannable, expanded to toggle individual skills
 * (`<source>/<skill>`). The agent stores the explicit ref list and the CP resolves
 * it into installable entries.
 *
 * A source enabled on the agent but no longer in the org registry still renders (as
 * a whole-source row) so it can be turned OFF, mirroring the MCP tools card.
 */

const sourceOf = (ref: string) => (ref.includes('/') ? ref.slice(0, ref.indexOf('/')) : ref)
const skillOf = (ref: string) => (ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : '*')

/** The agent's current selection for one source: whole-source vs a specific set. */
function selectionFor(enabled: string[], name: string): { all: boolean; skills: Set<string> } {
  const mine = enabled.filter((r) => sourceOf(r) === name)
  const all = mine.some((r) => skillOf(r) === '*')
  return { all, skills: new Set(mine.map(skillOf).filter((s) => s !== '*')) }
}

export function AgentSkillsCard({ agentId, canEdit }: { agentId: string; canEdit: boolean }) {
  const { updateAgent, skillSources } = useConsoleData()
  const [enabled, setEnabled] = useState<string[] | null>(null) // saved refs; null ⇒ not loaded
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [manifests, setManifests] = useState<Record<string, SkillSourceSkillsDto | 'loading'>>({})
  const fetched = useRef(false)

  useEffect(() => {
    if (fetched.current) return
    // Demo agents (canEdit false) have no spec to fetch — mock mode seeds a selection
    // so both tile states (whole source vs a picked subset) are visible.
    if (!canEdit) {
      if (MOCK_MODE) setEnabled(['example-ai-kit/*', 'internal-runbooks/safe-deploy'])
      return
    }
    fetched.current = true
    fetchAgentDto(agentId).then(
      (dto) => setEnabled(dto.skills ?? []),
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
  }, [agentId, canEdit])

  const save = async (next: string[]) => {
    if (enabled === null || saving) return
    const prev = enabled
    setEnabled(next)
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agentId, { skills: next })
    } catch (e) {
      setEnabled(prev) // revert so the toggles never lie about what's saved
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const withoutSource = (name: string) => (enabled ?? []).filter((r) => sourceOf(r) !== name)

  // Enable/disable a whole source ("<source>/*").
  const toggleSource = (name: string, on: boolean) => {
    if (!canEdit || enabled === null) return
    void save(on ? [...withoutSource(name), `${name}/*`] : withoutSource(name))
  }

  // Toggle one skill; converts a whole-source selection to an explicit set first,
  // and collapses back to "<source>/*" when every discovered skill ends up selected.
  const toggleSkill = (name: string, skill: string, discovered: string[]) => {
    if (!canEdit || enabled === null) return
    const cur = selectionFor(enabled, name)
    const set = cur.all ? new Set(discovered) : new Set(cur.skills)
    if (set.has(skill)) set.delete(skill)
    else set.add(skill)
    const base = withoutSource(name)
    if (set.size === 0) return void save(base)
    if (discovered.length > 0 && discovered.every((s) => set.has(s))) return void save([...base, `${name}/*`])
    void save([...base, ...[...set].map((s) => `${name}/${s}`)])
  }

  const expand = (id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (!manifests[id]) {
      setManifests((cur) => ({ ...cur, [id]: 'loading' }))
      fetchSkillSourceSkills(id).then(
        (m) => setManifests((cur) => ({ ...cur, [id]: m })),
        () => setManifests((cur) => ({ ...cur, [id]: { resolvable: false, skills: [] } }))
      )
    }
  }

  const known = new Set(skillSources.map((s) => s.name))
  const orphaned = [...new Set((enabled ?? []).map(sourceOf))].filter((n) => !known.has(n))

  const interactive = canEdit && enabled !== null && !saving

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="border-b border-(--border-subtle) px-4 py-3 font-sans text-[14px] font-semibold leading-normal desktop:py-[13px]">
        Skills
      </div>

      {skillSources.length === 0 && orphaned.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-[13px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary) desktop:py-3">
          <Icon name="book-open" size={14} />
          No skill sources in your organization yet.
        </div>
      ) : (
        <ToolTileGrid columns={2}>
          {skillSources.map((s) => {
            const sel = enabled ? selectionFor(enabled, s.name) : { all: false, skills: new Set<string>() }
            const on = sel.all || sel.skills.size > 0
            const manifest = manifests[s.id]
            const isOpen = expanded.has(s.id)
            return (
              <ToolTile
                key={s.id}
                mark={<SkillMark />}
                name={s.name}
                // What's selected rides as a badge so the second line can stay the repo,
                // matching the registry card's tile.
                badge={
                  on ? (
                    <span className="badge flex-none bg-(--status-info-soft) text-[9.5px] text-(--status-info)">
                      {sel.all ? 'all skills' : `${sel.skills.size} selected`}
                    </span>
                  ) : undefined
                }
                subtitle={<SkillSourceLine source={s.source} subDir={s.subDir} />}
                action={
                  <>
                    <button
                      type="button"
                      className="iconbtn h-6 w-6"
                      onClick={() => expand(s.id)}
                      aria-label="Show skills"
                      title="Show skills"
                    >
                      <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                    </button>
                    <span className="ml-[6px]">
                      <Toggle checked={on} disabled={!interactive} onChange={(next) => toggleSource(s.name, next)} />
                    </span>
                  </>
                }
              >
                {isOpen && (
                  <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-[14px] py-2">
                    {manifest === 'loading' || manifest === undefined ? (
                      <div className="py-1 font-sans text-[12px] text-(--text-tertiary)">Loading skills…</div>
                    ) : !manifest.resolvable || manifest.skills.length === 0 ? (
                      <div className="py-1 font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">
                        {manifest.resolvable
                          ? 'No SKILL.md found in this source.'
                          : 'Can’t list individual skills for this source — enable the whole source above.'}
                      </div>
                    ) : (
                      manifest.skills.map((sk) => {
                        const checked = sel.all || sel.skills.has(sk.name)
                        return (
                          <div key={sk.name} className="flex items-center gap-[11px] py-[7px]">
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-[12px] font-medium leading-normal text-(--text-primary)">
                                {sk.name}
                              </div>
                              <div className="truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                                {sk.dirPath}
                              </div>
                            </div>
                            <Toggle
                              checked={checked}
                              disabled={!interactive}
                              onChange={() =>
                                toggleSkill(
                                  s.name,
                                  sk.name,
                                  manifest.skills.map((x) => x.name)
                                )
                              }
                            />
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </ToolTile>
            )
          })}

          {orphaned.map((name) => (
            <ToolTile
              key={name}
              mark={<SkillMark />}
              name={name}
              subtitle="No longer in the org registry"
              dimmed
              action={<Toggle checked disabled={!interactive} onChange={() => toggleSource(name, false)} />}
            />
          ))}
        </ToolTileGrid>
      )}

      {err && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {err}
        </div>
      )}
    </div>
  )
}

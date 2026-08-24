'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchAgentDto,
  fetchAgentSkillSources,
  fetchSkillSourceSkills,
  listManagedSkills,
  repoLabel,
  type AgentSkillSourceDto,
  type ManagedSkillDto,
  type SkillSourceDto,
  type SkillSourceSkillsDto
} from '@/lib/api'
import { useConsoleData } from '@/lib/data-context'
import { MOCK_MODE } from '@/lib/data'
import { AttachedEmpty, AttachedNote, AttachedRow, AttachMenu } from '@/components/console/AttachedList'
import { InstallRegistrySkillModal } from '@/components/console/InstallRegistrySkillModal'
import { CreateSkillSourceModal } from '@/components/console/SkillSourcesCard'
import { SkillMark, SkillSourceLine } from '@/components/console/ToolTile'
import { Icon, Toggle } from '@/components/ui'

/**
 * The agent's shared-skills enable-list (docs/designs/shared-skills.md), rendered
 * as the design's attached-roster: one row per skill this agent installs, with the
 * header's Add menu offering the org's managed bundles and Git sources it hasn't
 * attached yet. A Git source can be enabled whole (`<source>/*`) or, when its
 * SKILL.md manifest is scannable, expanded to toggle individual skills
 * (`<source>/<skill>`). The agent stores the explicit ref list and the CP resolves
 * it into installable entries.
 *
 * The attached rows are the agent's own refs — `GET /agents/:id/skill-sources`
 * resolves them regardless of the source's own sharing, so a source restricted away
 * from the caller still shows its name and repo rather than a bare, unexplained row,
 * and can be removed. A ref whose source is genuinely gone resolves to nothing and
 * is not rendered: it installs nothing (the CP resolver drops it) and there is
 * nothing truthful to say about it. Only sources the caller can SEE are offered in
 * the Add menu — the CP rejects enabling an unseen one (`enablingUnseenSkillDenied`).
 *
 * The menu's quick-add items open the skills library's OWN dialogs
 * (`InstallRegistrySkillModal`, `CreateSkillSourceModal`), and a source registered
 * through either is enabled on this agent immediately.
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
  const { updateAgent, skillSources, skillSourcesLoading } = useConsoleData()
  const [enabled, setEnabled] = useState<string[] | null>(null) // saved refs; null ⇒ not loaded
  const [managedEnabled, setManagedEnabled] = useState<string[] | null>(null)
  const [managedLibrary, setManagedLibrary] = useState<ManagedSkillDto[] | null>(null)
  const [own, setOwn] = useState<AgentSkillSourceDto[] | null>(null) // sources this agent enables
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [manifests, setManifests] = useState<Record<string, SkillSourceSkillsDto | 'loading'>>({})
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const fetched = useRef(false)

  useEffect(() => {
    if (fetched.current) return
    // Demo agents (canEdit false) have no spec to fetch — mock mode seeds a selection
    // so both row states (whole source vs a picked subset) are visible.
    if (!canEdit) {
      if (MOCK_MODE) {
        setEnabled(['example-ai-kit/*', 'internal-runbooks/safe-deploy'])
        setManagedEnabled([])
        setManagedLibrary([])
        return
      }
    }
    fetched.current = true
    fetchAgentDto(agentId).then(
      (dto) => {
        setEnabled(dto.skills ?? [])
        setManagedEnabled(dto.managedSkills ?? [])
      },
      (e) => setErr(e instanceof Error ? e.message : String(e))
    )
    listManagedSkills(true).then(
      (rows) => setManagedLibrary(rows),
      (e) => {
        setManagedLibrary([])
        setErr(e instanceof Error ? e.message : String(e))
      }
    )
    // Resolving the agent's own refs is best-effort decoration: it only ADDS rows
    // for sources missing from the registry list, so a failure degrades to the
    // registry view rather than blocking the card.
    if (canEdit) {
      fetchAgentSkillSources(agentId).then(
        (rows) => setOwn(rows),
        () => setOwn([])
      )
    }
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
      setEnabled(prev) // revert so the rows never lie about what's saved
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const saveManaged = async (next: string[]) => {
    if (managedEnabled === null || saving) return
    const prev = managedEnabled
    const activeIds = new Set((managedLibrary ?? []).filter((skill) => !skill.archivedAt).map((skill) => skill.id))
    const valid = [...new Set(next)].filter((id) => activeIds.has(id))
    setManagedEnabled(valid)
    setSaving(true)
    setErr(null)
    try {
      await updateAgent(agentId, { managedSkills: valid })
    } catch (e) {
      setManagedEnabled(prev)
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

  // A source registered from this card is what the operator wanted on THIS agent,
  // so it is enabled whole as soon as the library accepts it.
  const enableCreated = (created: SkillSourceDto) => toggleSource(created.name, true)

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

  // Registry rows the caller can see, then the agent's own sources that sharing keeps
  // out of that list. The second group is `registry: false` — off-only, with no
  // per-skill picker, because the CP gates ADDING a ref on seeing the source; they
  // exist to say what the agent installs and to let it be removed.
  const sources = useMemo(() => {
    const known = new Set(skillSources.map((s) => s.name))
    // `registry` is a literal so it discriminates the union: only the registry arm
    // carries the fields the menu's repo hint reads.
    return [
      ...skillSources.map((s) => ({ ...s, registry: true as const })),
      ...(own ?? []).filter((s) => !known.has(s.name)).map((s) => ({ ...s, registry: false as const }))
    ]
  }, [skillSources, own])

  // Nothing is known yet while either list is in flight; rendering the empty state
  // then would claim the agent has nothing when we simply haven't asked.
  const loading = skillSourcesLoading || (canEdit && own === null) || managedLibrary === null || enabled === null
  const interactive = canEdit && enabled !== null && !saving

  const library = managedLibrary ?? []
  const managedIds = managedEnabled ?? []
  const attachedManaged = library.filter((skill) => managedIds.includes(skill.id))
  const attachedSources = sources.filter((s) => {
    const sel = enabled ? selectionFor(enabled, s.name) : null
    return !!sel && (sel.all || sel.skills.size > 0)
  })
  const empty = attachedManaged.length === 0 && attachedSources.length === 0

  const menu = canEdit ? (
    <AttachMenu
      ariaLabel="Add a skill to this agent"
      disabled={!interactive || managedEnabled === null}
      groups={[
        {
          heading: 'Managed skills',
          icon: 'package',
          options: library
            .filter((skill) => !skill.archivedAt && !managedIds.includes(skill.id))
            .map((skill) => ({
              key: skill.id,
              name: skill.name,
              meta: `rev ${skill.currentRevision}`,
              onPick: () => void saveManaged([...managedIds, skill.id])
            })),
          emptyLabel: 'No further approved managed skills to add.'
        },
        {
          heading: 'Git skill sources',
          icon: 'book-open',
          // Only registry sources are offerable — the CP rejects enabling a ref to a
          // source this caller can't see.
          options: sources
            .filter((s) => s.registry && !attachedSources.some((a) => a.name === s.name))
            .map((s) => ({
              key: s.id,
              name: s.name,
              meta: repoLabel(s.source),
              onPick: () => toggleSource(s.name, true)
            })),
          emptyLabel: 'Every source in your organization is already enabled.'
        }
      ]}
      actions={[
        { key: 'registry', label: 'Search skills.sh…', icon: 'search', onPick: () => setBrowsing(true) },
        { key: 'custom', label: 'Add custom skill source…', icon: 'plus', onPick: () => setCreating(true) }
      ]}
    />
  ) : undefined

  return (
    <div className="card overflow-hidden max-desktop:rounded-lg desktop:max-w-[760px]">
      <div className="cardhead flex-wrap gap-2">
        <span className="cardtitle">Skills</span>
        <span className="mono ml-auto text-[11px] text-(--text-tertiary)">managed bundles · Git sources</span>
        {menu}
      </div>

      {empty ? (
        <AttachedEmpty
          title={loading ? 'Loading skills…' : 'No skills'}
          hint={
            loading
              ? 'Reading this agent’s enabled skills.'
              : canEdit
                ? 'Enable a managed bundle or a Git source from your organization, or register a new one.'
                : 'This agent has no skills enabled.'
          }
          action={loading ? undefined : menu}
        />
      ) : (
        <>
          <div>
            {attachedManaged.map((skill) => (
              <AttachedRow
                key={skill.id}
                mark={<SkillMark />}
                name={skill.name}
                meta={`rev ${skill.currentRevision} · ${skill.fileCount} file${skill.fileCount === 1 ? '' : 's'} · immutable bundle`}
                dimmed={!!skill.archivedAt}
                badge={
                  <span
                    className={`badge flex-none ${skill.archivedAt ? 'bg-(--surface-sunken) text-(--text-disabled)' : 'bg-(--status-online-soft) text-(--status-online)'}`}
                  >
                    {skill.archivedAt ? 'archived' : 'managed'}
                  </span>
                }
                onRemove={
                  canEdit && !saving ? () => void saveManaged(managedIds.filter((id) => id !== skill.id)) : undefined
                }
                removeTitle="Remove from this agent"
              />
            ))}
            {attachedSources.map((s) => {
              const sel = enabled ? selectionFor(enabled, s.name) : { all: false, skills: new Set<string>() }
              const manifest = manifests[s.id]
              const isOpen = expanded.has(s.id)
              return (
                <AttachedRow
                  key={s.id}
                  mark={<SkillMark />}
                  name={s.name}
                  meta={<SkillSourceLine source={s.source} subDir={s.subDir} />}
                  badge={
                    <span className="badge flex-none bg-(--status-info-soft) text-(--status-info)">
                      {sel.all ? 'all skills' : `${sel.skills.size} selected`}
                    </span>
                  }
                  // An agent-scoped source has no per-skill picker: the CP would reject
                  // re-adding a ref to a source this caller can't see.
                  actions={
                    s.registry ? (
                      <button
                        type="button"
                        className="iconbtn h-[26px] w-[26px] flex-none"
                        onClick={() => expand(s.id)}
                        aria-label="Choose individual skills"
                        aria-expanded={isOpen}
                        title="Choose individual skills"
                      >
                        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} />
                      </button>
                    ) : undefined
                  }
                  onRemove={canEdit && !saving ? () => toggleSource(s.name, false) : undefined}
                  removeTitle="Remove from this agent"
                >
                  {isOpen && s.registry && (
                    <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-[14px] py-2">
                      {manifest === 'loading' || manifest === undefined ? (
                        <div className="py-1 font-sans text-[12px] text-(--text-tertiary)">Loading skills…</div>
                      ) : !manifest.resolvable || manifest.skills.length === 0 ? (
                        <div className="py-1 font-sans text-[12px] leading-[1.5] text-(--text-tertiary)">
                          {manifest.resolvable
                            ? 'No SKILL.md found in this source.'
                            : 'Can’t list individual skills for this source — the whole source is enabled.'}
                        </div>
                      ) : (
                        manifest.skills.map((sk) => (
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
                              checked={sel.all || sel.skills.has(sk.name)}
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
                        ))
                      )}
                    </div>
                  )}
                </AttachedRow>
              )
            })}
          </div>
          <AttachedNote>
            Managed bundles install from their pinned revision; Git sources install with{' '}
            <span className="mono text-[11.5px]">npx skills</span> on session start. Removing one stops installing it
            for this agent.
          </AttachedNote>
        </>
      )}

      {err && (
        <div className="border-t border-(--border-subtle) px-4 py-[11px] font-sans text-[12px] font-normal leading-normal text-(--red-600)">
          {err}
        </div>
      )}

      {browsing && (
        <div className="scrim">
          <div className="modal">
            <InstallRegistrySkillModal
              existing={skillSources}
              onClose={() => setBrowsing(false)}
              onCreated={enableCreated}
            />
          </div>
        </div>
      )}
      {creating && (
        <div className="scrim">
          <div className="modal">
            <CreateSkillSourceModal onClose={() => setCreating(false)} onCreated={enableCreated} />
          </div>
        </div>
      )}
    </div>
  )
}

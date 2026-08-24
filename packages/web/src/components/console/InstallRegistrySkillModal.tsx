'use client'

// "Install from skills.sh" — the second install path of the Skills library
// (docs/designs/shared-skills.md §7). Instead of hand-typing a repository, search
// the public skills.sh index BY NAME, pick a skill, and register it.
//
// A hit is registered as an ordinary Git skill source: `source` is the hit's
// `owner/repo` and `skills` is exactly the one skill picked, so the daemon's
// `npx skills add <owner/repo> -s <skill>` pass installs that skill alone. One
// library tile therefore means one skill here (the GitHub import path still
// registers a whole repo), which is how the registry itself is browsed.
//
// The search is proxied by the CP (skills.sh sends no CORS headers) and never
// persists anything — the create at the end is the only write.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { searchSkillRegistry, type SkillRegistryHitDto, type SkillSourceDto } from '@/lib/api'
import { VisibilityField, type SharingValue } from '@/components/console/VisibilityField'
import { Button, Icon } from '@/components/ui'

const DEBOUNCE_MS = 300
const MIN_QUERY = 2

function fmtInstalls(n: number | null): string | null {
  if (!n || n <= 0) return null
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`
  return `${n} install${n === 1 ? '' : 's'}`
}

/** A library name for a registry hit: the skill's own name, coerced to the
 *  server's name grammar and de-duplicated against the names already registered.
 *  Agents bind sources by name, and a create under a name they already enable is
 *  refused (409) — so a collision gets a suffix rather than a confusing error. */
export function registrySourceName(skill: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  const seed =
    skill
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|-+$/g, '')
      .slice(0, 64) || 'skill'
  if (!used.has(seed.toLowerCase())) return seed
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${seed.slice(0, 60)}-${i}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return seed
}

export function InstallRegistrySkillModal({
  existing,
  onClose,
  onCreated
}: {
  /** The org's current sources — for the "already in your library" state. */
  existing: SkillSourceDto[]
  onClose: () => void
  /** Fired with the registered source, so a caller can enable it on an agent. */
  onCreated?: (created: SkillSourceDto) => void
}) {
  const { createSkillSource } = useConsoleData()
  const { me } = useProfile()
  const [q, setQ] = useState('')
  // Results carry the query they answer, so an edited query hides the previous
  // hits for the whole debounce + network window instead of leaving rows from a
  // different search on screen and clickable.
  const [hits, setHits] = useState<{ query: string; reachable: boolean; skills: SkillRegistryHitDto[] } | null>(null)
  const [picked, setPicked] = useState<SkillRegistryHitDto | null>(null)
  const [name, setName] = useState('')
  const [sharing, setSharing] = useState<SharingValue>({ visibility: 'org', sharedWith: [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Only the newest query may write state — a slower earlier request must not
  // overwrite the results of the one the user is actually looking at.
  const seqRef = useRef(0)

  useEffect(() => {
    const query = q.trim()
    const seq = (seqRef.current += 1)
    if (query.length < MIN_QUERY) {
      setHits(null)
      return
    }
    const timer = setTimeout(() => {
      void searchSkillRegistry(query).then(
        (r) => {
          if (seqRef.current !== seq) return
          setHits({ query, reachable: r.reachable, skills: r.skills })
        },
        () => {
          if (seqRef.current !== seq) return
          setHits({ query, reachable: false, skills: [] })
        }
      )
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [q])

  const takenNames = useMemo(() => existing.map((s) => s.name), [existing])
  // Results are only shown while they still answer what the input says.
  const shown = hits && hits.query === q.trim() ? hits : null

  // A hit is already covered when some source points at the same repo AND either
  // names this skill explicitly or installs the whole repo. An empty filter only
  // means "whole repo" when the source isn't scoped to a subdirectory — a subDir
  // source installs just that directory, so skills elsewhere in the repo are still
  // installable.
  const coveredBy = (hit: SkillRegistryHitDto): SkillSourceDto | undefined =>
    existing.find(
      (s) =>
        s.source.trim().toLowerCase() === hit.source.toLowerCase() &&
        (s.skills.includes(hit.name) || (s.skills.length === 0 && !s.subDir))
    )

  const pick = (hit: SkillRegistryHitDto) => {
    setPicked(hit)
    setName(registrySourceName(hit.name, takenNames))
    setErr(null)
  }

  const valid = !!picked && !!name.trim() && /^[A-Za-z0-9._-]+$/.test(name.trim())

  const submit = async () => {
    if (!picked || !valid || busy) return
    setBusy(true)
    setErr(null)
    try {
      const created = await createSkillSource({
        name: name.trim(),
        source: picked.source,
        skills: [picked.name],
        ...(sharing.visibility === 'restricted'
          ? { visibility: 'restricted' as const, sharedWith: sharing.sharedWith }
          : {})
      })
      onCreated?.(created)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modalhead">
        <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
          <Icon name="search" size={16} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[16px] font-semibold leading-normal">Install from skills.sh</div>
          <div className="mt-[1px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            search the public registry, then install by name
          </div>
        </div>
        <button className="iconbtn" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modalbody">
        {picked ? (
          <div className="flex flex-col gap-[14px]">
            <div className="flex items-center gap-3 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-[13px] py-[11px]">
              <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
                <Icon name="book-open" size={15} color="var(--brand)" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                <span className="truncate font-mono text-[12.5px] font-semibold leading-normal">{picked.name}</span>
                <span className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                  {picked.source}
                </span>
              </span>
              <a
                className="lnk flex-none text-[11.5px]"
                href={`https://skills.sh/${picked.id}`}
                target="_blank"
                rel="noreferrer noopener"
              >
                View
              </a>
              <button className="lnk flex-none text-[11.5px]" onClick={() => setPicked(null)}>
                Change
              </button>
            </div>
            <div className="fld">
              <span className="fldlbl">Name in your library</span>
              <input className="inp mn" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
              <span className="mt-1 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                Agents enable skills by this name. Installs{' '}
                <span className="mono">
                  {picked.source} -s {picked.name}
                </span>{' '}
                on the daemon.
              </span>
            </div>
            <VisibilityField value={sharing} onChange={setSharing} />
          </div>
        ) : (
          <>
            <div className="fld">
              <span className="fldlbl">Search skills</span>
              <input
                className="inp"
                placeholder="pdf, code review, changelog…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
            </div>
            <div className="mt-3 flex flex-col gap-[6px]">
              {q.trim().length < MIN_QUERY ? (
                <div className="px-1 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  Type at least {MIN_QUERY} characters to search skills.sh — the same index{' '}
                  <span className="mono">npx skills find</span> reads.
                </div>
              ) : !shown ? (
                <div className="flex items-center gap-2 px-1 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  <Icon name="loader" size={14} className="animate-spin" />
                  Searching…
                </div>
              ) : !shown.reachable ? (
                <div className="flex items-start gap-2 rounded-[9px] border border-(--border-subtle) bg-(--surface-app) px-3 py-[11px] font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  <Icon name="info" size={14} className="mt-[1px] flex-none" />
                  <span>
                    Couldn&rsquo;t reach the skills.sh index. Try again, or import the repository directly with
                    &ldquo;Import from GitHub&rdquo;.
                  </span>
                </div>
              ) : shown.skills.length === 0 ? (
                <div className="px-1 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
                  No skills match &ldquo;{q.trim()}&rdquo;.
                </div>
              ) : (
                shown.skills.map((hit) => {
                  const covered = coveredBy(hit)
                  const installs = fmtInstalls(hit.installs)
                  return (
                    <button
                      key={hit.id}
                      className={`fopt min-h-[52px] items-center gap-3 rounded-[9px] px-3 py-2 ${
                        covered ? 'cursor-default opacity-55' : ''
                      }`}
                      disabled={!!covered}
                      onClick={() => pick(hit)}
                    >
                      <Icon name="book-open" size={16} color="var(--text-tertiary)" className="flex-none" />
                      <span className="flex min-w-0 flex-1 flex-col items-start gap-[2px] overflow-hidden">
                        <span className="block w-full min-w-0 truncate font-mono text-[12.5px] font-semibold leading-normal text-(--text-primary)">
                          {hit.name}
                        </span>
                        <span className="block w-full min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                          {covered ? `already in your library as ${covered.name}` : hit.source}
                        </span>
                      </span>
                      {covered ? (
                        <span className="badge flex-none bg-(--surface-active) text-(--text-tertiary)">added</span>
                      ) : (
                        installs && (
                          <span className="mono flex-none text-[10.5px] text-(--text-tertiary)">{installs}</span>
                        )
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </>
        )}
        {err && <div className="mt-3 font-sans text-[12px] font-normal leading-[1.5] text-(--status-error)">{err}</div>}
      </div>

      <div className="modalfoot">
        <span className="flex-1 truncate font-sans text-[11.5px] font-normal leading-[1.4] text-(--text-tertiary)">
          Skills run inside your agents — install only sources you trust.
        </span>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void submit()}
          className={valid && !busy ? undefined : 'pointer-events-none opacity-50'}
        >
          <Icon name="download" size={14} />
          {busy ? 'Installing…' : 'Install'}
        </Button>
      </div>
    </>
  )
}

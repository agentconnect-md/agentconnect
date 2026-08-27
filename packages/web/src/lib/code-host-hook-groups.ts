/**
 * A code-host row is `(agent, repo, family)`, so one watched repository is one
 * row per subject family and never a row of its own. This orders those rows
 * into per-repository blocks — a repository's rows adjacent, change proposals
 * before issues — and marks the block's edges: the FIRST row carries the repo
 * name and the "+ Issues" offer for what the repo does not watch yet, the LAST
 * row carries the divider that separates one repository from the next.
 */

import type { HookDto } from './api'
import { GH_FAMILIES, githubHookFamily, type GhFamily } from './github-events'
import { GL_FAMILIES, gitlabHookFamily, type GlFamily } from './gitlab-events'

// Sibling order for one repo: the change-proposal subject (it carries reviews), then issues, then the held-back push.
const GH_ROW_ORDER: readonly GhFamily[] = ['pull_request', 'issues', 'push']
const GL_ROW_ORDER: readonly GlFamily[] = ['merge_request', 'issues', 'push']

/** One listed subscription: its row, the family it covers (null on a legacy-inert row), and its place in the block. */
export interface CodeHostHookRow<F extends string> {
  hook: HookDto
  family: F | null
  /** Stable per-repository identity — the numeric repo id when the rows carry one. Keys the row's add-family state. */
  repoKey: string
  /** This row opens its repository's block: it names the repo and carries the add-family offer. */
  first: boolean
  /** This row closes its repository's block: it carries the divider to the next repository. */
  last: boolean
  /** Families this repository does not watch yet — carried by its FIRST row only, so the chip is offered once. */
  addFamilies: F[]
}

function hookLabel(hook: HookDto): string {
  return hook.repoFullName ?? hook.name
}

function orderRows<F extends string>(
  hooks: readonly HookDto[],
  familyOf: (hook: HookDto) => F | null,
  order: readonly F[],
  offered: readonly F[]
): CodeHostHookRow<F>[] {
  const byRepo = new Map<string, { label: string; rows: { hook: HookDto; family: F | null }[] }>()
  for (const hook of hooks) {
    const key = hook.repoId ?? hookLabel(hook)
    const group = byRepo.get(key)
    if (group) group.rows.push({ hook, family: familyOf(hook) })
    else byRepo.set(key, { label: hookLabel(hook), rows: [{ hook, family: familyOf(hook) }] })
  }
  // An unplaceable row sorts last rather than jumping ahead of the real subjects.
  const rank = (family: F | null) => (family === null ? order.length : order.indexOf(family))
  return [...byRepo.entries()]
    .sort(([, a], [, b]) => a.label.localeCompare(b.label))
    .flatMap(([repoKey, group]) => {
      const ordered = [...group.rows].sort((a, b) => rank(a.family) - rank(b.family))
      const present = new Set(ordered.map((row) => row.family))
      const missing = offered.filter((family) => !present.has(family))
      return ordered.map((row, index) => ({
        ...row,
        repoKey,
        first: index === 0,
        last: index === ordered.length - 1,
        addFamilies: index === 0 ? missing : []
      }))
    })
}

/** The agent's github rows in list order, each carrying its repo's add-family offer. */
export function orderedGithubHookRows(hooks: readonly HookDto[]): CodeHostHookRow<GhFamily>[] {
  return orderRows(
    hooks,
    githubHookFamily,
    GH_ROW_ORDER,
    // Offered in this file's sibling order, so a chip reads where its row would sit.
    GH_ROW_ORDER.filter((family) => GH_FAMILIES.some((tile) => tile.fam === family))
  )
}

/** The agent's gitlab rows in list order, each carrying its project's add-family offer. */
export function orderedGitlabHookRows(hooks: readonly HookDto[]): CodeHostHookRow<GlFamily>[] {
  return orderRows(
    hooks,
    gitlabHookFamily,
    GL_ROW_ORDER,
    GL_ROW_ORDER.filter((family) => GL_FAMILIES.some((tile) => tile.fam === family))
  )
}

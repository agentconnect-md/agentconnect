// Installation-wide GitHub rules (webhook-triggers-and-github-events.md, Installation-Wide Rows): filled in per event, then matched as repository rules.
import type { RcHookAssign } from '@agentconnect.md/protocol'
import type { HookTable } from './hook-table.js'
import { githubRuleFamilies, type GithubThreadFamily } from './github-routing.js'

/** The repository a signed event names; an empty name leaves installation rules out. */
export interface GithubEventRepository {
  repoId: string
  repoFullName: string
}

/** An installation rule filled in for one event's repository, keyed `github:<repoId>` as a new repository row is. */
export function githubRuleForRepository(rule: RcHookAssign, repo: GithubEventRepository): RcHookAssign {
  if (!rule.githubInstallation) return rule
  const { githubInstallation, ...rest } = rule
  const { installationId: _installationId, accountLogin: _accountLogin, ...matching } = githubInstallation
  return {
    ...rest,
    github: {
      ...matching,
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      sessionKeyPrefix: `github:${repo.repoId}`
    }
  }
}

type GithubRowFamily = GithubThreadFamily | 'push' | 'deployment' | 'release'

/** Every row family a rule's events name: the thread families as routing reads them, plus push, deployment (with its statuses) and release. */
function githubRowFamilies(
  github: Pick<NonNullable<RcHookAssign['github']>, 'events' | 'commentFamilies'>
): Set<GithubRowFamily> {
  const families = new Set<GithubRowFamily>(githubRuleFamilies(github))
  for (const pattern of github.events) {
    const prefix = pattern.split(':', 1)[0]
    if (prefix === 'push' || prefix === 'deployment' || prefix === 'release') families.add(prefix)
    else if (prefix === 'deployment_status') families.add('deployment')
  }
  return families
}

/** An installation rule gives way where its agent has a repository rule of the event's repository sharing a family. */
function overridden(rule: RcHookAssign, repositoryRules: readonly RcHookAssign[]): boolean {
  if (!rule.githubInstallation) return false
  const families = githubRowFamilies(rule.githubInstallation)
  return repositoryRules.some(
    (own) =>
      own.agentId === rule.agentId &&
      own.github !== undefined &&
      [...githubRowFamilies(own.github)].some((family) => families.has(family))
  )
}

/** The rules one GitHub event may fire: its repository's, then its installation's that no repository rule overrides. */
export function githubRulesForEvent(
  table: Pick<HookTable, 'getByCodeHostRepo' | 'getByGithubInstallation'>,
  repo: GithubEventRepository,
  installationId: string | undefined
): RcHookAssign[] {
  const repositoryRules = table.getByCodeHostRepo('github', repo.repoId)
  if (installationId === undefined || !repo.repoFullName) return repositoryRules
  const installationRules = table
    .getByGithubInstallation(installationId)
    .filter((rule) => !overridden(rule, repositoryRules))
    .map((rule) => githubRuleForRepository(rule, repo))
  return [...repositoryRules, ...installationRules]
}

/** One rule re-read by id for an event's repository, an installation rule filled in for it unless a repository rule now overrides it. */
export function githubRuleByHookId(
  table: Pick<HookTable, 'getByHookId' | 'getByCodeHostRepo'>,
  hookId: string,
  repo: GithubEventRepository
): RcHookAssign | undefined {
  const rule = table.getByHookId(hookId)
  if (!rule?.githubInstallation) return rule
  if (!repo.repoFullName || overridden(rule, table.getByCodeHostRepo('github', repo.repoId))) return undefined
  return githubRuleForRepository(rule, repo)
}

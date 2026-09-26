import { describe, expect, it } from 'vitest'
import type { RcHookAssign } from '@agentconnect.md/protocol'
import { HookTable } from './hook-table.js'
import { githubRuleByHookId, githubRuleForRepository, githubRulesForEvent } from './github-installation.js'

const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_AGENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const DAEMON = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REPOSITORY_HOOK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INSTALLATION_HOOK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REPO = { repoId: '555', repoFullName: 'example-org/tools' }

const matching = { labelFilter: [], mentionOnly: false, installationIds: ['1234567'] }

function repositoryRule(events = ['issues:opened'], agentId = AGENT): RcHookAssign {
  return {
    hookId: REPOSITORY_HOOK,
    kind: 'github',
    agentId,
    daemonId: DAEMON,
    sessionMode: 'perThread',
    github: {
      ...matching,
      events,
      repoId: REPO.repoId,
      repoFullName: REPO.repoFullName,
      sessionKeyPrefix: 'github:555'
    }
  }
}

function installationRule(events = ['issues:opened'], installationId = '1234567'): RcHookAssign {
  return {
    hookId: INSTALLATION_HOOK,
    kind: 'github',
    agentId: AGENT,
    daemonId: DAEMON,
    sessionMode: 'perThread',
    githubInstallation: {
      ...matching,
      events,
      installationIds: [installationId],
      installationId,
      accountLogin: 'example-org'
    }
  }
}

describe('githubRuleForRepository', () => {
  it('fills an installation rule in as the repository rule of the event, keyed like a new repository row', () => {
    const filled = githubRuleForRepository(installationRule(), REPO)
    expect(filled).not.toHaveProperty('githubInstallation')
    expect(filled.github).toEqual({
      ...matching,
      events: ['issues:opened'],
      repoId: '555',
      repoFullName: 'example-org/tools',
      sessionKeyPrefix: 'github:555'
    })
  })

  it('leaves a repository rule as it is', () => {
    const rule = repositoryRule()
    expect(githubRuleForRepository(rule, REPO)).toBe(rule)
  })
})

describe('HookTable installation index', () => {
  it('indexes an installation rule by its installation, never by a repository, and drops it on remove', () => {
    const table = new HookTable()
    table.upsert(installationRule())
    expect(table.getByGithubInstallation('1234567').map((rule) => rule.hookId)).toEqual([INSTALLATION_HOOK])
    expect(table.getByCodeHostRepo('github', REPO.repoId)).toEqual([])

    table.upsert(installationRule(['issues:opened'], '7654321'))
    expect(table.getByGithubInstallation('1234567')).toEqual([])
    expect(table.getByGithubInstallation('7654321').map((rule) => rule.hookId)).toEqual([INSTALLATION_HOOK])

    table.remove(INSTALLATION_HOOK)
    expect(table.getByGithubInstallation('7654321')).toEqual([])
  })
})

describe('githubRulesForEvent', () => {
  it('adds the installation’s rules, filled in, after the repository’s own', () => {
    const table = new HookTable()
    table.upsert(repositoryRule(['issues:opened'], OTHER_AGENT))
    table.upsert(installationRule())
    const rules = githubRulesForEvent(table, REPO, '1234567')
    expect(rules.map((rule) => rule.hookId)).toEqual([REPOSITORY_HOOK, INSTALLATION_HOOK])
    expect(rules[1]?.github?.repoId).toBe('555')
  })

  it('drops an installation rule its own agent overrides with a repository rule of the family', () => {
    const table = new HookTable()
    table.upsert(repositoryRule())
    table.upsert(installationRule())
    expect(githubRulesForEvent(table, REPO, '1234567').map((rule) => rule.hookId)).toEqual([REPOSITORY_HOOK])

    table.upsert(repositoryRule(['pull_request:opened']))
    expect(githubRulesForEvent(table, REPO, '1234567').map((rule) => rule.hookId)).toEqual([
      REPOSITORY_HOOK,
      INSTALLATION_HOOK
    ])
  })

  it.each([
    ['push', ['push:*'], ['push:*']],
    ['deployment, its statuses included', ['deployment:*'], ['deployment_status:*']],
    ['release', ['release:published'], ['release:*']]
  ])('lets a repository rule override an installation rule of %s', (_family, own, installation) => {
    const table = new HookTable()
    table.upsert(repositoryRule(own))
    table.upsert(installationRule(installation))
    expect(githubRulesForEvent(table, REPO, '1234567').map((rule) => rule.hookId)).toEqual([REPOSITORY_HOOK])
    expect(githubRuleByHookId(table, INSTALLATION_HOOK, REPO)).toBeUndefined()

    table.upsert(repositoryRule(['issues:opened']))
    expect(githubRulesForEvent(table, REPO, '1234567').map((rule) => rule.hookId)).toEqual([
      REPOSITORY_HOOK,
      INSTALLATION_HOOK
    ])
  })

  it('offers only repository rules without a signed installation or a repository name', () => {
    const table = new HookTable()
    table.upsert(installationRule())
    expect(githubRulesForEvent(table, REPO, undefined)).toEqual([])
    expect(githubRulesForEvent(table, { ...REPO, repoFullName: '' }, '1234567')).toEqual([])
    expect(githubRulesForEvent(table, REPO, '7654321')).toEqual([])
  })
})

describe('githubRuleByHookId', () => {
  it('re-reads an installation rule filled in for the event, and nothing once a repository rule overrides it', () => {
    const table = new HookTable()
    table.upsert(installationRule())
    expect(githubRuleByHookId(table, INSTALLATION_HOOK, REPO)?.github?.repoFullName).toBe('example-org/tools')
    expect(githubRuleByHookId(table, INSTALLATION_HOOK, { ...REPO, repoFullName: '' })).toBeUndefined()

    table.upsert(repositoryRule())
    expect(githubRuleByHookId(table, INSTALLATION_HOOK, REPO)).toBeUndefined()
    expect(githubRuleByHookId(table, REPOSITORY_HOOK, REPO)?.hookId).toBe(REPOSITORY_HOOK)
  })
})

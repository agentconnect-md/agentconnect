import { describe, expect, it } from 'vitest'
import { orderedGithubHookRows, orderedGitlabHookRows } from './code-host-hook-groups'
import type { HookDto } from './api'

function hook(partial: Partial<HookDto> & Pick<HookDto, 'id'>): HookDto {
  return {
    agentId: 'agent-1',
    kind: 'github',
    name: partial.repoFullName ?? 'owner/repo',
    sessionMode: 'perThread',
    enabled: true,
    url: null,
    hmacConfigured: false,
    repoId: null,
    repoFullName: 'owner/repo',
    family: null,
    events: [],
    commentFamilies: [],
    labelFilter: [],
    mentionOnly: false,
    configRevision: '1',
    reviewPolicy: 'off',
    reportingMode: 'off',
    gateMode: 'informational',
    lastFiredAt: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial
  } as HookDto
}

describe('orderedGithubHookRows', () => {
  it('keeps a repository as two rows, change proposals first', () => {
    const rows = orderedGithubHookRows([
      hook({ id: 'a', repoId: '1', repoFullName: 'acme/api', family: 'issues', events: ['issues:*'] }),
      hook({ id: 'b', repoId: '1', repoFullName: 'acme/api', family: 'pull_request', events: ['pull_request:*'] })
    ])
    expect(rows.map((row) => row.hook.id)).toEqual(['b', 'a'])
    expect(rows.map((row) => row.family)).toEqual(['pull_request', 'issues'])
    expect(rows.every((row) => row.repoKey === '1')).toBe(true)
    // The block's edges: the opener names the repo, the closer carries the divider.
    expect(rows.map((row) => [row.first, row.last])).toEqual([
      [true, false],
      [false, true]
    ])
    // Nothing left to add, so no row offers a chip.
    expect(rows.flatMap((row) => row.addFamilies)).toEqual([])
  })

  it('offers a missing family on the repository first row only', () => {
    const rows = orderedGithubHookRows([
      hook({ id: 'a', repoId: '1', repoFullName: 'acme/api', family: 'issues', events: ['issues:*'] })
    ])
    expect(rows[0]!.addFamilies).toEqual(['pull_request'])
    // A one-row block opens and closes on the same row.
    expect([rows[0]!.first, rows[0]!.last]).toEqual([true, true])
  })

  it('never offers the held-back push subject', () => {
    const rows = orderedGithubHookRows([
      hook({ id: 'a', repoId: '1', repoFullName: 'acme/api', family: 'pull_request', events: ['pull_request:*'] }),
      hook({ id: 'b', repoId: '1', repoFullName: 'acme/api', family: 'issues', events: ['issues:*'] })
    ])
    expect(rows.flatMap((row) => row.addFamilies)).toEqual([])
  })

  it('keeps a repository adjacent and sorts repositories by name', () => {
    const rows = orderedGithubHookRows([
      hook({ id: 'w1', repoId: '2', repoFullName: 'acme/web', family: 'issues', events: ['issues:*'] }),
      hook({ id: 'a1', repoId: '1', repoFullName: 'acme/api', family: 'issues', events: ['issues:*'] }),
      hook({ id: 'a2', repoId: '1', repoFullName: 'acme/api', family: 'pull_request', events: ['pull_request:*'] })
    ])
    expect(rows.map((row) => row.hook.id)).toEqual(['a2', 'a1', 'w1'])
  })

  it('derives a legacy row family from its events and sorts an unplaceable one last', () => {
    const rows = orderedGithubHookRows([
      hook({ id: 'a', repoId: '1', repoFullName: 'acme/api', family: null, events: ['issue_comment:created'] }),
      hook({ id: 'b', repoId: '1', repoFullName: 'acme/api', family: null, events: ['pull_request:*'] })
    ])
    expect(rows.map((row) => row.family)).toEqual(['pull_request', null])
    // The unplaceable row covers nothing, so issues is still on offer — on the first row.
    expect(rows[0]!.addFamilies).toEqual(['issues'])
    expect(rows[1]!.addFamilies).toEqual([])
  })

  it('keys a repository with no numeric id by its name', () => {
    const rows = orderedGithubHookRows([
      hook({ id: 'a', repoFullName: 'acme/api', family: 'issues', events: ['issues:*'] }),
      hook({ id: 'b', repoFullName: 'acme/api', family: 'pull_request', events: ['pull_request:*'] })
    ])
    expect(rows.map((row) => row.repoKey)).toEqual(['acme/api', 'acme/api'])
    expect(rows.flatMap((row) => row.addFamilies)).toEqual([])
  })
})

describe('orderedGitlabHookRows', () => {
  it('leads with merge requests and offers the missing subject', () => {
    const rows = orderedGitlabHookRows([
      hook({ id: 'a', kind: 'gitlab', repoId: '7', repoFullName: 'group/proj', family: 'issues', events: ['issues:*'] })
    ])
    expect(rows[0]!.addFamilies).toEqual(['merge_request'])
    const both = orderedGitlabHookRows([
      hook({
        id: 'a',
        kind: 'gitlab',
        repoId: '7',
        repoFullName: 'group/proj',
        family: 'issues',
        events: ['issues:*']
      }),
      hook({
        id: 'b',
        kind: 'gitlab',
        repoId: '7',
        repoFullName: 'group/proj',
        family: 'merge_request',
        events: ['merge_request:*']
      })
    ])
    expect(both.map((row) => row.family)).toEqual(['merge_request', 'issues'])
    expect(both.flatMap((row) => row.addFamilies)).toEqual([])
  })
})

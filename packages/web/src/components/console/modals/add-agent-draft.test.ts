import { describe, expect, it } from 'vitest'
import { addAgentDraftSeed, draftWorkspaceTile } from './add-agent-draft'

const SET_ID = '33333333-3333-4333-8333-333333333333'

describe('addAgentDraftSeed', () => {
  it('leaves the form untouched when no card proposed anything', () => {
    expect(addAgentDraftSeed()).toMatchObject({
      name: '',
      runtime: '',
      daemonValue: '',
      wsMode: 'scratch',
      repo: '',
      url: '',
      branch: 'main',
      worktree: true,
      push: false,
      permissionMode: null
    })
  })

  it('seeds every field a proposal named', () => {
    expect(
      addAgentDraftSeed({
        name: 'reviewer',
        displayName: 'Reviewer',
        description: 'reviews',
        runtime: 'claude',
        model: 'opus',
        reasoningEffort: 'high',
        outputMode: 'low',
        fastMode: true,
        permissionMode: 'plan',
        placementKind: 'daemon',
        daemonId: 'daemon-1',
        workspace: { mode: 'git', gitRepo: 'acme/api', gitBranch: 'develop', agentDir: 'svc', access: 'write' }
      })
    ).toEqual({
      name: 'reviewer',
      displayName: 'Reviewer',
      description: 'reviews',
      runtime: 'claude',
      model: 'opus',
      effort: 'high',
      fastMode: true,
      permissionMode: 'plan',
      outputMode: 'low',
      daemonValue: 'daemon-1',
      wsMode: 'github',
      repo: 'acme/api',
      url: '',
      branch: 'develop',
      agentDir: 'svc',
      worktree: true,
      push: true
    })
  })

  it('opens the placement picker on the target the proposal named', () => {
    expect(addAgentDraftSeed({ name: 'a', placementKind: 'pool', daemonId: 'ignored' }).daemonValue).toBe('')
    expect(addAgentDraftSeed({ name: 'a', placementKind: 'set', setId: SET_ID }).daemonValue).toContain(SET_ID)
    // A set placement without its set names nothing rather than pinning the machine beside it.
    expect(addAgentDraftSeed({ name: 'a', placementKind: 'set', daemonId: 'daemon-1' }).daemonValue).toBe('daemon-1')
  })

  it('lands a clone address on the tile that can clone it', () => {
    for (const [address, tile] of [
      ['acme/api', 'github'],
      ['https://github.com/acme/api.git', 'github'],
      ['git@github.com:acme/api.git', 'github'],
      ['https://git.example.test/acme/api.git', 'giturl'],
      ['ssh://git@git.example.test/acme/api.git', 'giturl']
    ] as const) {
      expect(draftWorkspaceTile(address), address).toBe(tile)
    }
    const url = addAgentDraftSeed({
      name: 'a',
      workspace: { mode: 'git', gitRepo: 'https://git.example.test/acme/api.git' }
    })
    expect(url).toMatchObject({ wsMode: 'giturl', url: 'https://git.example.test/acme/api.git', repo: '' })
    // A scratch workspace carries no address, whatever else the proposal said.
    expect(addAgentDraftSeed({ name: 'a', workspace: { mode: 'scratch' } })).toMatchObject({
      wsMode: 'scratch',
      repo: '',
      url: ''
    })
  })
})

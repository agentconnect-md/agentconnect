import { describe, expect, it } from 'vitest'
import { GITLAB_COM_V1_FEATURE } from '@agentconnect.md/protocol'
import { daemonSupportsAgent, requiredDaemonFeatures } from './daemon-features.js'
import type { AgentRecord } from '../persistence/ports.js'

const workspace = (mode: string) => ({ workspace: { mode } as AgentRecord['workspace'] })

describe('§17.3 snapshot projection gate predicate', () => {
  it('requires nothing for every storable workspace shape today', () => {
    expect(requiredDaemonFeatures(workspace('scratch'))).toEqual([])
    expect(requiredDaemonFeatures(workspace('github'))).toEqual([])
  })

  it('gates a gitlab-shaped workspace on gitlab-com-v1', () => {
    expect(requiredDaemonFeatures(workspace('gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
  })

  it('gates a gitlab ADDITIONAL repository, whatever the workspace is', () => {
    // The quieter half: an older daemon strips the unknown `provider` key, so a
    // two-segment project path would read as an owner/repo GitHub entry and be
    // cloned from github.com. Only the assembled spec carries this, which is why
    // the predicate takes it structurally.
    const withGrant = (mode: string, provider: string) => ({
      workspace: { mode, additionalRepos: [{ repoFullName: 'a/b', repoId: '1', provider }] } as never
    })
    expect(requiredDaemonFeatures(withGrant('scratch', 'gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredDaemonFeatures(withGrant('github', 'gitlab'))).toEqual([GITLAB_COM_V1_FEATURE])
    expect(requiredDaemonFeatures(withGrant('scratch', 'github'))).toEqual([])
    expect(daemonSupportsAgent(withGrant('scratch', 'gitlab'), [])).toBe(false)
    expect(daemonSupportsAgent(withGrant('scratch', 'gitlab'), [GITLAB_COM_V1_FEATURE])).toBe(true)
  })

  it('fails closed: absent or feature-less advertisements support only ungated agents', () => {
    expect(daemonSupportsAgent(workspace('github'), undefined)).toBe(true)
    expect(daemonSupportsAgent(workspace('gitlab'), undefined)).toBe(false)
    expect(daemonSupportsAgent(workspace('gitlab'), [])).toBe(false)
    expect(daemonSupportsAgent(workspace('gitlab'), ['some-other-feature'])).toBe(false)
    expect(daemonSupportsAgent(workspace('gitlab'), [GITLAB_COM_V1_FEATURE])).toBe(true)
  })
})

// `automerge/set` from the CP: which arms carry the session that places their watcher (k8s-daemon-pool §4).
import { AUTO_MERGE_FEATURE, AUTO_MERGE_SESSION_FEATURE } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { autoMergeSetRequest } from './autoMerge.js'

const TARGET = { agentId: 'a1', repoFullName: 'acme/app', prNumber: 7 }
const SESSION = { id: 's1', agentId: 'a1' }
const CURRENT = [AUTO_MERGE_FEATURE, AUTO_MERGE_SESSION_FEATURE]

describe('autoMergeSetRequest', () => {
  it('names the arming session to a daemon that places a watcher by it', () => {
    expect(autoMergeSetRequest(TARGET, true, SESSION, CURRENT)).toEqual({ ...TARGET, enabled: true, sessionId: 's1' })
  })

  it('keeps an older daemon’s frame byte-identical, so it arms in the agent pod as before', () => {
    expect(autoMergeSetRequest(TARGET, true, SESSION, [AUTO_MERGE_FEATURE])).toEqual({ ...TARGET, enabled: true })
  })

  it('sends no session on a disarm, which finds the watcher wherever it lives', () => {
    expect(autoMergeSetRequest(TARGET, false, SESSION, CURRENT)).toEqual({ ...TARGET, enabled: false })
  })

  it('sends no session that belongs to another agent than the one whose watcher it is', () => {
    // A pull-request run's agent can differ from the session's; that session's pod is not the watcher agent's.
    expect(autoMergeSetRequest(TARGET, true, { id: 's1', agentId: 'a2' }, CURRENT)).toEqual({
      ...TARGET,
      enabled: true
    })
  })
})

import { describe, expect, it } from 'vitest'
import { SessionStayedHomeReason } from '@agentconnect.md/protocol'
import english from '../../messages/en.json'
import { stayedHomeReasonKey } from './session-executor'

const phrases = english.Sessions.detail.stayedHome as Record<string, string>

describe('stayedHomeReasonKey', () => {
  it('has a phrase for each visible stay-home reason', () => {
    for (const reason of SessionStayedHomeReason.options.filter((reason) => reason !== 'memory_daemon_homed')) {
      const key = stayedHomeReasonKey(reason)
      expect(key, reason).toBeDefined()
      expect(phrases[key!], reason).toBeTruthy()
    }
  })

  it('omits the daemon-memory suffix', () => {
    expect(stayedHomeReasonKey('memory_daemon_homed')).toBeUndefined()
  })

  it('says nothing for a session with no verdict, and for a reason it has no phrase for', () => {
    expect(stayedHomeReasonKey(null)).toBeUndefined()
    expect(stayedHomeReasonKey(undefined)).toBeUndefined()
    // A newer Control Plane naming a value this console predates: no phrase, and no throw.
    expect(stayedHomeReasonKey('some_later_reason')).toBeUndefined()
  })

  it('words the ordinary outcome as a placement result rather than a failure', () => {
    // The holder simply hosted the fewest sessions. Reading this as an error would send an
    // operator hunting for a fault that is not there.
    expect(phrases[stayedHomeReasonKey('holder_least_loaded')!]).toBe('least loaded')
  })
})

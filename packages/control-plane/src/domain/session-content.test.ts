import { describe, it, expect } from 'vitest'
import { sessionContentReaders } from './session-content.js'

describe('sessionContentReaders — who can serve a session transcript', () => {
  it('reads from the recorder alone when it kept a private store', () => {
    expect(sessionContentReaders({ recordedDaemonId: 'd-rec', sharedStoreMembers: [] })).toEqual(['d-rec'])
  })

  it('answers nothing when the recorder is gone and no shared store holds it', () => {
    expect(sessionContentReaders({ recordedDaemonId: null, sharedStoreMembers: [] })).toEqual([])
  })

  it('falls back to every member of the store a retired pool recorder wrote to', () => {
    expect(sessionContentReaders({ recordedDaemonId: null, sharedStoreMembers: ['m-c', 'm-a', 'm-b'] })).toEqual([
      'm-a',
      'm-b',
      'm-c'
    ])
  })

  it('keeps the recorder first and never repeats it as a member', () => {
    expect(sessionContentReaders({ recordedDaemonId: 'm-b', sharedStoreMembers: ['m-a', 'm-b', 'm-c'] })).toEqual([
      'm-b',
      'm-a',
      'm-c'
    ])
  })
})

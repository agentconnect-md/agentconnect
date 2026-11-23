// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { composerDraftKey, moveComposerDraft, readComposerDraft, writeComposerDraft } from './composer-draft'

beforeEach(() => sessionStorage.clear())

describe('composer drafts', () => {
  it('keys an unsent playground page by its agent, so a reloaded page with a new id finds it', () => {
    expect(composerDraftKey('pg_agent-1_uuid-a')).toBe(composerDraftKey('pg_agent-1_uuid-b'))
    expect(composerDraftKey('pg_agent-1_uuid-a')).not.toBe(composerDraftKey('pg_agent-2_uuid-a'))
    expect(composerDraftKey('session-1')).not.toBe(composerDraftKey('session-2'))
  })

  it('stores text and forgets a blank draft', () => {
    writeComposerDraft('session-1', 'Say hello')
    expect(readComposerDraft('session-1')).toBe('Say hello')
    writeComposerDraft('session-1', '  ')
    expect(readComposerDraft('session-1')).toBe('')
    expect(sessionStorage.length).toBe(0)
  })

  it('hands a reopened page its draft without overwriting one the target already holds', () => {
    writeComposerDraft('pg_agent-1_uuid-a', 'Say hello')
    moveComposerDraft('pg_agent-1_uuid-a', 'session-1')
    expect(readComposerDraft('session-1')).toBe('Say hello')
    expect(readComposerDraft('pg_agent-1_uuid-b')).toBe('')

    writeComposerDraft('pg_agent-1_uuid-c', 'newer')
    writeComposerDraft('session-1', 'kept')
    moveComposerDraft('pg_agent-1_uuid-c', 'session-1')
    expect(readComposerDraft('session-1')).toBe('kept')
  })

  it('keeps a draft when the page reopens under the same agent key', () => {
    writeComposerDraft('pg_agent-1_uuid-a', 'Say hello')
    moveComposerDraft('pg_agent-1_uuid-a', 'pg_agent-1_uuid-b')
    expect(readComposerDraft('pg_agent-1_uuid-b')).toBe('Say hello')
  })
})

import { describe, expect, it } from 'vitest'
import { TranscriptRecorder } from '../src/session/transcript-recorder.js'
import { EPHEMERAL_RESULT_MARKER, EPHEMERAL_RESULT_NOTE } from '../src/session/ephemeral-results.js'

/**
 * Slack's Real-time Search API: "You must not store or copy any of the data retrieved from
 * this API." Everything else a tool returns is ordinary transcript material, so without this
 * the recorder would persist the retrieved message text, authors and permalinks to the daemon
 * DB and serve them through tool-body reads.
 *
 * The tests below are written against the SERIALIZED row rather than a field path, for the
 * same reason the redaction scans that way: a runtime is free to echo a tool result in
 * `rawOutput`, in `content` blocks, or nested inside either, and a check pinned to one shape
 * would pass while the data leaked through another.
 */
const HIT = 'we decided to ship on Thursday'

const searchUpdate = (over: Record<string, unknown> = {}) =>
  ({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'searchPublicMessages',
    status: 'completed',
    rawInput: { query: 'rollout decision' },
    rawOutput: { policy: EPHEMERAL_RESULT_NOTE, messages: [{ text: HIT, permalink: 'https://x/p1' }] },
    ...over
  }) as never

describe('ephemeral tool results are not persisted', () => {
  it('keeps the row and the agent’s own query, and drops what the search retrieved', () => {
    const [event] = new TranscriptRecorder().onUpdate(searchUpdate())
    expect(event).toBeDefined()
    const row = event as { kind: string; toolCallId: string; body: string }

    expect(row.kind).toBe('tool')
    expect(row.toolCallId).toBe('call-1')
    // The retrieved data is gone…
    expect(row.body).not.toContain(HIT)
    expect(row.body).not.toContain('https://x/p1')
    // …while the call itself, its status, and the agent's OWN query remain, or the row would
    // be uninterpretable to anyone reading the transcript later.
    expect(row.body).toContain('rollout decision')
    expect(row.body).toContain('completed')
  })

  // A runtime that reports the result as content blocks instead of rawOutput must be covered
  // by the same scan — this is the shape a field-path check would miss.
  it('redacts when the marker arrives in content blocks instead', () => {
    const [event] = new TranscriptRecorder().onUpdate(
      searchUpdate({
        rawOutput: undefined,
        content: [{ type: 'content', content: { type: 'text', text: `${EPHEMERAL_RESULT_MARKER}\n${HIT}` } }]
      })
    )
    const row = event as { body: string }
    expect(row.body).not.toContain(HIT)
  })

  it('redacts every update in the call’s burst, not just the first', () => {
    const recorder = new TranscriptRecorder()
    recorder.onUpdate(searchUpdate({ status: 'in_progress', rawOutput: undefined }))
    const [event] = recorder.onUpdate(searchUpdate({ sessionUpdate: 'tool_call_update' }))
    const row = event as { body: string; op: string }
    expect(row.op).toBe('update')
    expect(row.body).not.toContain(HIT)
  })

  it('leaves an ordinary tool result completely alone', () => {
    const [event] = new TranscriptRecorder().onUpdate(
      searchUpdate({ rawOutput: { messages: [{ text: HIT }] }, title: 'getThreadHistory' })
    )
    const row = event as { body: string }
    expect(row.body).toContain(HIT)
  })
})

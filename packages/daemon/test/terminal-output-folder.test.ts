/**
 * codex-acp sends a shell command's output OUT OF BAND — `_meta.terminal_output_delta`
 * chunks on status-less updates, then a terminal update whose own `formatted_output` is
 * empty. The folder repairs the terminal update at ACP ingress so every consumer (the
 * transcript, the web console, the Slack card) sees the command's real output.
 */
import { describe, expect, it } from 'vitest'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'

const delta = (id: string, data: string) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  _meta: { terminal_output_delta: { data, terminal_id: id } }
})
const done = (id: string, rawOutput: unknown = { formatted_output: '', exit_code: 0 }) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
  status: 'completed',
  rawOutput
})

describe('TerminalOutputFolder', () => {
  it('accumulates deltas and injects them into the terminal update', () => {
    const folder = new TerminalOutputFolder()
    expect(folder.fold(delta('t1', 'line one\n'))).toEqual(delta('t1', 'line one\n'))
    folder.fold(delta('t1', 'line two'))
    expect(folder.fold(done('t1'))).toMatchObject({
      status: 'completed',
      rawOutput: { formatted_output: 'line one\nline two', exit_code: 0 }
    })
  })

  it('treats terminal_output as the same delta stream under another key', () => {
    // codex-acp routes every chunk through one stream; `terminal_output` only renames the
    // meta key when the client advertises the capability. A replacement reading would
    // collapse a command's output to its last chunk.
    const folder = new TerminalOutputFolder()
    folder.fold(delta('t1', 'first chunk\n'))
    folder.fold({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      _meta: { terminal_output: { data: 'second chunk', terminal_id: 't1' } }
    })
    expect(folder.fold(done('t1'))).toMatchObject({ rawOutput: { formatted_output: 'first chunk\nsecond chunk' } })
  })

  it('never clobbers output the update carries itself', () => {
    const folder = new TerminalOutputFolder()
    folder.fold(delta('t1', 'buffered'))
    const own = done('t1', { formatted_output: 'already here', exit_code: 0 })
    expect(folder.fold(own)).toBe(own)
    const withContent = {
      ...done('t2'),
      content: [{ type: 'content', content: { type: 'text', text: 'tool said this' } }]
    }
    folder.fold(delta('t2', 'buffered'))
    expect(folder.fold(withContent)).toBe(withContent)
  })

  it('drops the buffer once the call settles, and keeps calls separate', () => {
    const folder = new TerminalOutputFolder()
    folder.fold(delta('t1', 'first call'))
    folder.fold(delta('t2', 'second call'))
    expect(folder.fold(done('t1'))).toMatchObject({ rawOutput: { formatted_output: 'first call' } })
    // A repeated terminal update finds nothing left to inject.
    const again = done('t1')
    expect(folder.fold(again)).toBe(again)
    expect(folder.fold(done('t2'))).toMatchObject({ rawOutput: { formatted_output: 'second call' } })
  })

  it('leaves failed calls repaired too, and non-tool updates alone', () => {
    const folder = new TerminalOutputFolder()
    folder.fold(delta('t1', 'exit 1 detail'))
    expect(folder.fold({ ...delta('t1', ''), status: 'failed' })).toMatchObject({
      rawOutput: { formatted_output: 'exit 1 detail' }
    })
    const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }
    expect(folder.fold(chunk)).toBe(chunk)
  })

  it('caps a runaway stream well below the transcript body ceiling', () => {
    // The transcript sheds rawOutput ENTIRELY when the serialized body tops 1 MiB, so a
    // fold near that ceiling would erase itself — the cap has to leave serialization room.
    const folder = new TerminalOutputFolder()
    for (let i = 0; i < 24; i++) folder.fold(delta('t1', 'y'.repeat(64 * 1024)))
    const folded = folder.fold(done('t1')) as { rawOutput: { formatted_output: string } }
    expect(folded.rawOutput.formatted_output.length).toBe(256 * 1024)
  })
})

/**
 * Folds codex-acp's out-of-band terminal output back into the tool call it belongs to.
 *
 * For a shell command, codex-acp sends no `content[]` text at all: the output streams as
 * `_meta.terminal_output*` delta chunks on status-less `tool_call_update`s, and the completing
 * update carries only `rawOutput.formatted_output: ""`. Nothing downstream reads `_meta`, so the transcript, the
 * web console and every platform renderer showed a command with an empty result.
 *
 * This runs ONCE at the daemon's ACP ingress — the `maskAgentSecrets` precedent — so every
 * consumer sees the same repaired update: the accumulated text is injected as
 * `rawOutput.formatted_output` on the call's terminal update, and only when that update did
 * not carry output of its own.
 */

/** Head-cap per call, WELL below the transcript's 1 MiB body ceiling: that ceiling measures
 *  the serialized whole ToolBody in UTF-8 bytes and sheds `rawOutput` entirely when over, so
 *  a fold near the ceiling would erase itself. 256 KiB of UTF-16 code units leaves ample
 *  room in practice (JSON-escaped control characters can reach 6 bytes per unit, but terminal
 *  output is overwhelmingly printable), plus headroom for rawInput/content. */
const MAX_TERMINAL_OUTPUT_UNITS = 256 * 1024

type MetaOutput = { data?: unknown; terminal_id?: unknown }

type ToolUpdate = {
  sessionUpdate?: unknown
  toolCallId?: unknown
  status?: unknown
  content?: unknown
  rawOutput?: unknown
  _meta?: { terminal_output?: MetaOutput; terminal_output_delta?: MetaOutput }
}

/** Whether the update already carries readable output — folded text must never clobber it. */
function carriesOwnOutput(u: ToolUpdate): boolean {
  if (Array.isArray(u.content)) {
    for (const item of u.content) {
      const block = (item as { type?: string; content?: { type?: string; text?: string } } | null)?.content
      if (block?.type === 'text' && block.text) return true
    }
  }
  if (typeof u.rawOutput === 'string' && u.rawOutput.trim()) return true
  const formatted = (u.rawOutput as { formatted_output?: unknown } | undefined)?.formatted_output
  return typeof formatted === 'string' && formatted.trim().length > 0
}

export class TerminalOutputFolder {
  private buffers = new Map<string, string>()

  /** Absorb one raw ACP update. Returns the update every downstream consumer should see —
   *  the same object when there is nothing to fold, a shallow copy with the repaired
   *  `rawOutput` on the call's terminal update. */
  fold(update: unknown): unknown {
    const u = update as ToolUpdate
    if (u?.sessionUpdate !== 'tool_call' && u?.sessionUpdate !== 'tool_call_update') return update
    const meta = u._meta
    const full = meta?.terminal_output
    const delta = meta?.terminal_output_delta
    const id =
      typeof u.toolCallId === 'string' && u.toolCallId
        ? u.toolCallId
        : typeof (full ?? delta)?.terminal_id === 'string'
          ? ((full ?? delta)!.terminal_id as string)
          : ''
    if (!id) return update
    // BOTH meta spellings carry deltas: codex-acp routes every chunk through the same
    // stream and `terminal_output` merely renames the key when the client advertises that
    // capability — `createTerminalOutputMeta` is handed `event.delta` either way, never the
    // aggregate. Treating it as a replacement would collapse a command to its last chunk.
    const data = typeof full?.data === 'string' ? full.data : typeof delta?.data === 'string' ? delta.data : ''
    if (data) {
      const held = this.buffers.get(id) ?? ''
      if (held.length < MAX_TERMINAL_OUTPUT_UNITS) {
        this.buffers.set(id, held + data.slice(0, MAX_TERMINAL_OUTPUT_UNITS - held.length))
      }
    }
    if (u.status !== 'completed' && u.status !== 'failed') return update
    const buffered = this.buffers.get(id)
    this.buffers.delete(id)
    if (!buffered?.trim() || carriesOwnOutput(u)) return update
    const rawOutput = u.rawOutput && typeof u.rawOutput === 'object' ? u.rawOutput : {}
    return { ...u, rawOutput: { ...rawOutput, formatted_output: buffered } }
  }
}

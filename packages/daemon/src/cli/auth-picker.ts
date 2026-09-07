/**
 * Arrow-key list for `agentconnect auth`.
 *
 * One flat list in a FIXED order: the login sweep launches every runtime and answers slowly, so a
 * verdict arrives as a per-row status rather than as a re-sort. A list that reorders itself under
 * the cursor is unusable. The same list drives both the runtime choice and the method choice.
 *
 * Deliberately dependency-free and stream-injected: the daemon ships no TUI library, and the key
 * decoding is what tests drive. Rendering redraws in place on a TTY and degrades to a plain list
 * when stdin is not a terminal, so a piped or CI invocation still shows what it would have offered.
 */

export interface PickerRow {
  id: string
  /** Display name, when there is one worth showing beside the id. */
  name?: string
  /** Trailing detail: the live login status, or what a method does. */
  hint?: string
}

export interface PickerIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (raw: boolean) => void }
  output: NodeJS.WritableStream & { isTTY?: boolean }
}

/**
 * The rows to show, which may still be changing. Row ORDER is fixed for the life of the picker;
 * only each row's `hint` is expected to change, so the operator can select at any point —
 * including before the first verdict lands.
 */
export interface PickerModel {
  rows(): PickerRow[]
  /** Called on every change; returns its own unsubscribe. Absent means the list is final. */
  subscribe?: (listener: () => void) => () => void
}

/** A model for a list that will not change. */
export function fixedRows(rows: PickerRow[]): PickerModel {
  return { rows: () => rows }
}

const ESC = '\u001b'
const CTRL_C = '\u0003'

function label(row: PickerRow): string {
  const name = row.name && row.name !== row.id ? ` (${row.name})` : ''
  return `${row.id}${name}${row.hint ? ` — ${row.hint}` : ''}`
}

/** The list as lines, with `cursor` marked. Exported for tests and the non-TTY fallback. */
export function renderPicker(rows: PickerRow[], cursor: number): string[] {
  return rows.map((row, index) => `${index === cursor ? '❯' : ' '} ${label(row)}`)
}

/**
 * Show the list and resolve the chosen id, or undefined when the operator cancelled (q / Esc /
 * Ctrl-C). Non-TTY input prints the rows and resolves undefined — there is nothing to steer with,
 * and guessing a selection for someone is worse than saying so.
 */
export async function pickRow(model: PickerModel, io: PickerIo, prompt: string): Promise<string | undefined> {
  const write = (text: string): void => void io.output.write(text)
  if (model.rows().length === 0) return undefined

  if (!io.input.isTTY || !io.input.setRawMode) {
    for (const line of renderPicker(model.rows(), -1)) write(`${line}\n`)
    return undefined
  }

  // The cursor follows the ROW ID, not the row number: the order is fixed, but a model is free to
  // grow, and an index would then point somewhere the operator never put it.
  let selected = model.rows()[0]!.id
  let painted = 0
  const paint = (): void => {
    const rows = model.rows()
    const cursor = Math.max(
      0,
      rows.findIndex((row) => row.id === selected)
    )
    selected = rows[cursor]?.id ?? selected
    if (painted > 0) write(`${ESC}[${painted}A${ESC}[0J`)
    const lines = renderPicker(rows, cursor)
    write(`${lines.join('\n')}\n`)
    painted = lines.length
  }

  io.input.setRawMode(true)
  io.input.resume()
  if ('setEncoding' in io.input) (io.input as NodeJS.ReadStream).setEncoding('utf8')
  write(`${prompt} — ↑/↓ to move, Enter to select, q to cancel.\n\n`)
  paint()

  const unsubscribe = model.subscribe?.(paint)

  return await new Promise<string | undefined>((resolve) => {
    const finish = (value: string | undefined): void => {
      unsubscribe?.()
      io.input.removeListener('data', onData)
      io.input.setRawMode?.(false)
      io.input.pause()
      write('\n')
      resolve(value)
    }
    const move = (delta: number): void => {
      const rows = model.rows()
      const at = Math.max(
        0,
        rows.findIndex((row) => row.id === selected)
      )
      selected = rows[(at + delta + rows.length) % rows.length]!.id
      paint()
    }
    const onData = (chunk: string | Buffer): void => {
      const keys = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      // A single read can carry a whole escape sequence, or several keys at once when held down.
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!
        if (key === ESC && keys[i + 1] === '[') {
          const code = keys[i + 2]
          i += 2
          if (code === 'A') move(-1)
          else if (code === 'B') move(1)
          continue
        }
        if (key === ESC || key === CTRL_C || key === 'q') return finish(undefined)
        if (key === '\r' || key === '\n') return finish(selected)
        if (key === 'k') move(-1)
        else if (key === 'j') move(1)
      }
    }
    io.input.on('data', onData)
  })
}

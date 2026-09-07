import { describe, it, expect } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { fixedRows, pickRow, renderPicker, type PickerIo, type PickerRow } from '../src/cli/auth-picker.js'

const ROWS: PickerRow[] = [
  { id: 'antigravity-acp', name: 'Google Antigravity', hint: 'not logged in' },
  { id: 'claude-acp', name: 'Claude Agent', hint: 'logged in — 5 model(s), 0.73.0' },
  { id: 'grok-build', name: 'Grok Build', hint: 'checking…' }
]

function capture(): { stream: Writable; text: () => string } {
  let buf = ''
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString()
      cb()
    }
  })
  return { stream, text: () => buf }
}

/** A stdin that claims to be a terminal, so the picker takes its interactive path. */
function tty(): { io: PickerIo; press: (keys: string) => void; out: () => string; raw: boolean[] } {
  const input = new PassThrough() as unknown as PickerIo['input']
  const raw: boolean[] = []
  ;(input as { isTTY?: boolean }).isTTY = true
  ;(input as { setRawMode?: (v: boolean) => void }).setRawMode = (value) => raw.push(value)
  const output = capture()
  return {
    io: { input, output: output.stream as PickerIo['output'] },
    press: (keys) => (input as unknown as PassThrough).write(keys),
    out: output.text,
    raw
  }
}

const DOWN = '\u001b[B'
const UP = '\u001b[A'
const ENTER = '\r'

describe('renderPicker', () => {
  it('renders one line per row and marks the cursor', () => {
    expect(renderPicker(ROWS, 1)).toEqual([
      '  antigravity-acp (Google Antigravity) — not logged in',
      '❯ claude-acp (Claude Agent) — logged in — 5 model(s), 0.73.0',
      '  grok-build (Grok Build) — checking…'
    ])
  })

  it('repeats no name that is the id, and omits an absent hint', () => {
    expect(renderPicker([{ id: 'omp', name: 'omp' }, { id: 'cline' }], 0)).toEqual(['❯ omp', '  cline'])
  })
})

describe('pickRow', () => {
  it('returns the row under the cursor', async () => {
    const t = tty()
    const chosen = pickRow(fixedRows(ROWS), t.io, 'Select a runtime to log in')
    t.press(DOWN)
    t.press(DOWN)
    t.press(ENTER)
    expect(await chosen).toBe('grok-build')
    expect(t.raw).toEqual([true, false]) // raw mode is always restored
    expect(t.out()).toContain('Select a runtime to log in — ↑/↓ to move, Enter to select, q to cancel.')
  })

  it('wraps at the ends and accepts j/k as well as the arrows', async () => {
    const t = tty()
    const chosen = pickRow(fixedRows(ROWS), t.io, 'Pick')
    t.press('k') // up from the first row wraps to the last
    t.press(ENTER)
    expect(await chosen).toBe('grok-build')
  })

  it('handles several keys, and a whole escape sequence, in one read', async () => {
    const t = tty()
    const chosen = pickRow(fixedRows(ROWS), t.io, 'Pick')
    t.press(`${DOWN}${DOWN}${UP}`)
    t.press(ENTER)
    expect(await chosen).toBe('claude-acp')
  })

  it('returns nothing when the operator cancels', async () => {
    for (const key of ['q', '\u001b', '\u0003']) {
      const t = tty()
      const chosen = pickRow(fixedRows(ROWS), t.io, 'Pick')
      t.press(key)
      expect(await chosen).toBeUndefined()
      expect(t.raw).toEqual([true, false])
    }
  })

  it('prints the rows and picks nothing when stdin is not a terminal', async () => {
    const input = new PassThrough() as unknown as PickerIo['input']
    const output = capture()
    const chosen = await pickRow(fixedRows(ROWS), { input, output: output.stream as PickerIo['output'] }, 'Pick')
    expect(chosen).toBeUndefined()
    expect(output.text()).toContain('antigravity-acp (Google Antigravity) — not logged in')
  })

  it('picks nothing when there is nothing to pick', async () => {
    const t = tty()
    expect(await pickRow(fixedRows([]), t.io, 'Pick')).toBeUndefined()
  })

  it('never leaves a data listener behind', async () => {
    const t = tty()
    const chosen = pickRow(fixedRows(ROWS), t.io, 'Pick')
    t.press(ENTER)
    await chosen
    expect((t.io.input as unknown as PassThrough).listenerCount('data')).toBe(0)
  })

  it('rewinds exactly the lines it painted, so the list updates in place', async () => {
    const t = tty()
    const chosen = pickRow(fixedRows(ROWS), t.io, 'Pick')
    t.press(DOWN)
    t.press(ENTER)
    await chosen
    expect(t.out()).toContain('\u001b[3A\u001b[0J')
  })
})

describe('pickRow with a list whose statuses are still arriving', () => {
  /** Rows in a FIXED order whose hints change, the way the login sweep reports verdicts. */
  function liveModel(): {
    model: Parameters<typeof pickRow>[0]
    land: (id: string, hint: string) => void
    listeners: Set<() => void>
  } {
    const hints = new Map<string, string>()
    const listeners = new Set<() => void>()
    return {
      model: {
        rows: () => ROWS.map((row) => ({ ...row, hint: hints.get(row.id) ?? 'checking…' })),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      },
      land: (id, hint) => {
        hints.set(id, hint)
        for (const listener of listeners) listener()
      },
      listeners
    }
  }

  it('repaints in place without moving the cursor off the row it was on', async () => {
    const { model, land } = liveModel()
    const t = tty()
    const chosen = pickRow(model, t.io, 'Pick')
    t.press(DOWN) // cursor on claude-acp
    // A verdict for the row ABOVE the cursor must not disturb the selection.
    land('antigravity-acp', 'not logged in')
    land('claude-acp', 'logged in — 5 model(s)')
    t.press(ENTER)
    expect(await chosen).toBe('claude-acp')
    expect(t.out()).toContain('claude-acp (Claude Agent) — logged in — 5 model(s)')
  })

  it('lets the operator choose before a single verdict has landed', async () => {
    const { model } = liveModel()
    const t = tty()
    const chosen = pickRow(model, t.io, 'Pick')
    t.press(DOWN)
    t.press(DOWN)
    t.press(ENTER)
    expect(await chosen).toBe('grok-build')
    expect(t.out()).toContain('checking…')
  })

  it('unsubscribes from the model on the way out', async () => {
    const { model, listeners } = liveModel()
    const t = tty()
    const chosen = pickRow(model, t.io, 'Pick')
    t.press(ENTER)
    await chosen
    expect(listeners.size).toBe(0)
  })
})

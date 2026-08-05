import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * integration-plugin-audit.md §10.6 F1 — the NUL trap.
 *
 * `daemon.ts` used two RAW NUL characters as separators in a composite key. One NUL
 * anywhere in a file makes ripgrep classify the WHOLE file as binary: it prints
 * `binary file matches` and no lines, for every pattern. That silently turned every
 * `rg`-based sweep over `daemon.ts` into a pass — including the S2 exit criterion's own
 * "zero platform conditionals in daemon.ts" check, whose entire subject is this file.
 *
 * The trap is invisible by construction (the byte does not render), so it is pinned
 * mechanically rather than left to reviewer attention.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url))
/** U+0000, spelled so this file never contains the byte it is guarding against. */
const NUL = String.fromCharCode(0)

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

describe('daemon source hygiene', () => {
  it('has no raw NUL byte in any source file, so `rg` reads them all as text', () => {
    // Exactly ripgrep's binary trigger: a single 0x00 in the buffer. Checking the byte
    // rather than shelling out to `rg` keeps the guard working on a runner that has no
    // ripgrep installed, while pinning the same condition.
    const offenders = sourceFiles(SRC)
      .map((path) => ({ path, at: readFileSync(path).indexOf(0) }))
      .filter(({ at }) => at !== -1)
      .map(({ path, at }) => `${path.slice(SRC.length + 1)} (offset ${at})`)
    expect(offenders).toEqual([])
  })

  it('keeps the session-purge grouping key on NUL, written as an escape', () => {
    // The VALUE must not change: the key groups purge receipts into one CP frame per
    // (agent, reason, purge time), and NUL is the separator because no component can
    // contain it. This pins the spelling, so swapping the separator for something a
    // component COULD contain has to be a deliberate, visible edit. The grouping
    // behavior itself is pinned by daemon-lifecycle.test.ts ("never reports a session
    // under another purge time or agent").
    const source = readFileSync(join(SRC, 'daemon.ts'), 'utf8')
    expect(source).toContain('const key = `${row.agentId}\\0${row.reason}\\0${row.purgedAt}`')
    // …and the escape really is U+0000, not a two-character sequence — so the key the
    // source produces now is character-for-character the key it produced before.
    expect(`a\0b`).toBe(`a${NUL}b`)
    expect(`a\0b`).toHaveLength(3)
  })
})

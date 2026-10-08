/**
 * Vitest global setup: point every test's `os.tmpdir()` at one directory per run, and remove it at
 * teardown.
 *
 * The suite creates hundreds of `mkdtemp(join(tmpdir(), 'ac-…-'))` roots and cleans up almost none of
 * them, and a daemon test root is a whole store plus agent dirs. On a machine that runs the suite
 * all day those pile up in `/tmp` by the tens of thousands. Scoping the run is the one place that
 * catches every case, including the daemons, runtimes and helpers the tests spawn, since they
 * inherit the env.
 *
 * Workers are started after this runs, so they inherit the env set here. The name is short on
 * purpose: SRT's multiplexer socket sits under a temp dir inside an agent dir, and every byte added
 * here comes out of the 107-byte `sun_path` budget (see `src/acp/sandbox-temp.ts`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEMP_ENV = ['TMPDIR', 'TMP', 'TEMP'] as const

export function setup(): () => void {
  const previous = TEMP_ENV.map((key) => [key, process.env[key]] as const)
  const root = mkdtempSync(join(tmpdir(), 'acdt-'))
  for (const key of TEMP_ENV) process.env[key] = root
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

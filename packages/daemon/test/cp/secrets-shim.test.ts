import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { secretsShimDir, writeSecretsShim } from '../../src/cp/secrets-shim.js'

// capability-requests.md §4.9.2: the daemon's `run/secrets-bin` carries `agentconnect-secrets`, calling the CLI's `secrets`.
describe.skipIf(process.platform === 'win32')('agentconnect-secrets wrapper', () => {
  let root: string | undefined
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('forwards its whole argv to the daemon CLI secrets command under this daemon root', () => {
    root = mkdtempSync(join(tmpdir(), 'secrets-shim-'))
    const cliEntry = join(root, 'fake-cli.mjs')
    writeFileSync(
      cliEntry,
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), root: process.env.AGENTCONNECT_ROOT }))\n`
    )
    const dir = writeSecretsShim(root, cliEntry)
    expect(dir).toBe(secretsShimDir(root))
    expect(existsSync(join(dir, 'gh'))).toBe(false)
    const wrapper = join(dir, 'agentconnect-secrets')
    expect(existsSync(wrapper)).toBe(true)
    const out = execFileSync('sh', [wrapper, 'exec', '--only', 'A', '--', 'curl'], { encoding: 'utf8' })
    expect(JSON.parse(out)).toEqual({ argv: ['secrets', 'exec', '--only', 'A', '--', 'curl'], root })
  })
})

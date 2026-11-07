import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRuntimeWrappers } from '../src/execution/host-shim.js'
import { shimPaths } from '../src/shim/sandbox-paths.js'

// A placed session on an installation (host or srt strategy) has no image `pathbin`, and npm packs an
// installation's files without their executable bit: the launcher writes `agentconnect-secrets` per launch.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An installation's helper root and a runtime root. */
function layout() {
  const base = mkdtempSync(join(tmpdir(), 'ac-hs-wrappers-'))
  dirs.push(base)
  const helperRoot = join(base, 'dist')
  const runtimeRoot = join(base, 'hs', '0a1b2c3d4e5f')
  for (const dir of [join(helperRoot, 'shim'), runtimeRoot]) mkdirSync(dir, { recursive: true })
  return shimPaths(runtimeRoot, helperRoot)
}

describe.skipIf(process.platform === 'win32')("a host shim's runtime wrappers", () => {
  it('put an executable agentconnect-secrets on the runtime PATH (capability-requests.md §4.9.2)', async () => {
    const paths = layout()
    writeFileSync(paths.secretsEntry, "process.stdout.write('secrets:' + process.argv.slice(2).join(' '))\n")
    await writeRuntimeWrappers(paths)
    const wrapper = join(paths.runtimeWrapperDir, 'agentconnect-secrets')
    expect(statSync(wrapper).mode & 0o777).toBe(0o755)
    // No gh or glab wrapper: a session's CLIs present the credential proxy's placeholder themselves.
    expect(readdirSync(paths.runtimeWrapperDir)).toEqual(['agentconnect-secrets'])
    const env = { PATH: `${paths.runtimeWrapperDir}:/usr/bin:/bin` }
    expect(execFileSync('agentconnect-secrets', ['exec', '--only', 'A', '--', 'env'], { env, encoding: 'utf8' })).toBe(
      'secrets:exec --only A -- env'
    )
  })

  it('leave the directory absent when the installation ships no secrets entry', async () => {
    const paths = layout()
    await writeRuntimeWrappers(paths)
    expect(existsSync(paths.runtimeWrapperDir)).toBe(false)
  })
})

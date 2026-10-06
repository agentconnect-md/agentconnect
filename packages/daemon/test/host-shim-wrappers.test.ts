import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRuntimeWrappers } from '../src/execution/host-shim.js'
import { shimPaths } from '../src/shim/sandbox-paths.js'

// A placed session on an installation (host or srt strategy) has no image `pathbin`, and npm packs an
// installation's files without their executable bit: the launcher writes the gh and glab wrappers per launch.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An installation's helper root with stand-in token entries, a runtime root, and fake real CLIs. */
function layout() {
  const base = mkdtempSync(join(tmpdir(), 'ac-hs-wrappers-'))
  dirs.push(base)
  const helperRoot = join(base, 'dist')
  const runtimeRoot = join(base, 'hs', '0a1b2c3d4e5f')
  const bin = join(base, 'bin')
  for (const dir of [join(helperRoot, 'shim'), runtimeRoot, bin]) mkdirSync(dir, { recursive: true })
  // Stand-ins for the built token entries: they print a token naming the agent they were asked for.
  for (const tool of ['gh', 'glab'])
    writeFileSync(
      join(helperRoot, 'shim', `${tool}-token.js`),
      `process.stdout.write('${tool}-token-for-' + process.argv[2])\n`
    )
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "GH_TOKEN=$GH_TOKEN args=$*"\n', { mode: 0o755 })
  writeFileSync(join(bin, 'glab'), '#!/bin/sh\necho "GITLAB_TOKEN=$GITLAB_TOKEN args=$*"\n', { mode: 0o755 })
  return { paths: shimPaths(runtimeRoot, helperRoot), bin }
}

describe.skipIf(process.platform === 'win32')("a host shim's gh and glab wrappers", () => {
  it('are executable and hand the real CLI a token fetched through the helper root', async () => {
    const { paths, bin } = layout()
    await writeRuntimeWrappers(paths)
    const env = { PATH: `${paths.runtimeWrapperDir}:${bin}:/usr/bin:/bin`, AC_AGENT_ID: 'agent-a' }
    for (const tool of ['gh', 'glab']) {
      expect(statSync(join(paths.runtimeWrapperDir, tool)).mode & 0o777).toBe(0o755)
    }
    // Found by PATH lookup, as a runtime finds it, and skipping itself while it locates the real one.
    expect(execFileSync('gh', ['pr', 'create'], { env, encoding: 'utf8' }).trim()).toBe(
      'GH_TOKEN=gh-token-for-agent-a args=pr create'
    )
    expect(execFileSync('glab', ['mr', 'list'], { env, encoding: 'utf8' }).trim()).toBe(
      'GITLAB_TOKEN=glab-token-for-agent-a args=mr list'
    )
  })
})

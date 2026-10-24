import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test(
  'the macOS app publishes only the build of this release, scanned by its binaries',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ac-computer-app-release-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(repo, 'packages/computer/bundle/computer-darwin-arm64'), { recursive: true })
    mkdirSync(bin)
    writeFileSync(log, '')
    // Fake executables record every call; this fixture can never invoke a real npm publisher.
    for (const tool of ['pnpm', 'npm']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf "${tool} %s\\n" "$*" >> "$RELEASE_TEST_LOG"\n`, { mode: 0o755 })
    }
    copyFileSync(new URL('publish-computer-app.sh', import.meta.url), join(repo, 'scripts', 'publish-computer-app.sh'))
    writeFileSync(
      join(repo, 'packages/computer/bundle/computer-darwin-arm64/package.json'),
      '{"name":"@agentconnect.md/computer-darwin-arm64","version":"2.7.0"}\n'
    )
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_TEST_LOG: log,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    }
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet'], { cwd: repo, env })
    const run = (...args) =>
      spawnSync('sh', ['scripts/publish-computer-app.sh', ...args], { cwd: repo, env, encoding: 'utf8' })

    const stale = run('arm64', '2.8.0', 'prepare')
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /built as 2\.7\.0, not 2\.8\.0/)
    assert.equal(readFileSync(log, 'utf8'), '')

    assert.equal(run('arm64', '2.7.0', 'prepare').status, 0)
    assert.equal(run('arm64', 'latest', 'publish').status, 0)
    const pkg = join(repo, 'packages/computer/bundle/computer-darwin-arm64')
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      `pnpm run license-scan --binaries-only ${pkg}`,
      `npm publish ${pkg} --tag latest --access public`
    ])
  }
)

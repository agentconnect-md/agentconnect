import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

test(
  'computer daemon publication builds, scans and publishes only when its bundle inputs changed',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ac-computer-release-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    const log = join(root, 'pnpm.log')
    mkdirSync(repo)
    mkdirSync(bin)
    writeFileSync(log, '')
    // A fake executable records every phase; this fixture can never invoke a real npm publisher.
    writeFileSync(
      join(bin, 'pnpm'),
      '#!/bin/sh\nprintf "%s|%s\\n" "${AGENTCONNECT_RELEASE_VERSION-}" "$*" >> "$RELEASE_TEST_LOG"\n',
      { mode: 0o755 }
    )
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RELEASE_TEST_LOG: log,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1'
    }
    delete env.AGENTCONNECT_RELEASE_VERSION
    const run = (command, args) => execFileSync(command, args, { cwd: repo, env, encoding: 'utf8' })
    const git = (...args) =>
      run('git', [
        '-c',
        'user.name=Release Test',
        '-c',
        'user.email=release@example.test',
        '-c',
        'commit.gpgsign=false',
        ...args
      ])
    const write = (path, content) => {
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), content)
    }
    mkdirSync(join(repo, 'scripts'))
    copyFileSync(
      new URL('publish-computer-if-changed.sh', import.meta.url),
      join(repo, 'scripts', 'publish-computer-if-changed.sh')
    )
    write('packages/computer/package.json', '{"name":"release-test","version":"2.0.0-dev"}\n')
    write('packages/protocol/src/index.ts', 'export const v = 1\n')
    write('packages/daemon/src/index.ts', 'export const d = 1\n')
    write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    git('-c', 'init.templateDir=', 'init', '--quiet')
    const commit = (tag) => {
      git('add', '.')
      git('commit', '--quiet', '-m', tag)
      git('tag', tag)
    }
    commit('v1.0.0')

    const publish = (previous, version, channel = 'latest', pins) => {
      writeFileSync(log, '')
      run('sh', ['scripts/publish-computer-if-changed.sh', previous, version, 'prepare', ...(pins ? [pins] : [])])
      run('sh', ['scripts/publish-computer-if-changed.sh', previous, channel, 'publish'])
      return readFileSync(log, 'utf8')
    }

    // No baseline (never published): build with the release version, scan dist, strip dependencies, pin the apps, publish.
    const first = publish('', '1.0.0', 'latest', '{"@agentconnect.md/computer-darwin-arm64":"0.9.0"}')
    assert.match(first, /^\|exec json -I -f package\.json -e this\.version='1\.0\.0'$/m)
    assert.match(first, /^1\.0\.0\|run build$/m)
    assert.match(first, /^\|run license-scan dist$/m)
    // Stripping and pinning are one exec, the last before publish: a later exec would find the dependencies gone and reinstall.
    assert.match(
      first,
      /^\|exec json -I -f package\.json -e this\.dependencies=\{\}; this\.optionalDependencies=\{"@agentconnect\.md\/computer-darwin-arm64":"0\.9\.0"\}\n\|publish --no-git-checks --ignore-scripts --tag latest$/m
    )

    write('packages/daemon/src/index.ts', 'export const d = 2\n')
    commit('v1.0.1')
    assert.equal(publish('v1.0.0', '1.0.1'), '')

    write('packages/protocol/src/index.ts', 'export const v = 2\n')
    commit('v1.0.2-rc.1')
    const rc = publish('v1.0.1', '1.0.2-rc.1', 'rc')
    assert.match(rc, /^1\.0\.2-rc\.1\|run build$/m)
    assert.match(rc, /^\|exec json -I -f package\.json -e this\.dependencies=\{\}; this\.optionalDependencies=\{\}$/m)
    assert.match(rc, /^\|publish --no-git-checks --ignore-scripts --tag rc$/m)

    write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n# a dependency changed\n')
    commit('v1.0.3')
    assert.match(publish('v1.0.2-rc.1', '1.0.3'), /^1\.0\.3\|run build$/m)

    // An unknown baseline tag rebuilds rather than skipping.
    assert.match(publish('v0.0.9', '1.0.3'), /^1\.0\.3\|run build$/m)
  }
)

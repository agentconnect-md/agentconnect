import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

test(
  'daemon publication follows runtime-image inputs while unrelated source changes still skip',
  { skip: process.platform === 'win32' },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-release-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const repo = join(root, 'repo')
    const bin = join(root, 'bin')
    const log = join(root, 'pnpm.log')
    mkdirSync(repo)
    mkdirSync(bin)
    writeFileSync(log, '')
    // A fake executable records both phases; this fixture can never invoke a real npm publisher.
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
    for (const script of ['component-versions.sh', 'publish-daemon-if-changed.sh', 'runtime-sandbox-inputs.sh']) {
      copyFileSync(new URL(script, import.meta.url), join(repo, 'scripts', script))
    }
    write('packages/daemon/package.json', '{"name":"release-test","version":"1.0.0-dev"}\n')
    write('docker/runtime-sandbox.Dockerfile', 'FROM scratch\n')
    write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    git('-c', 'init.templateDir=', 'init', '--quiet')
    const commit = (tag) => {
      git('add', '.')
      git('commit', '--quiet', '-m', tag)
      git('tag', tag)
    }
    commit('v1.0.0')

    const components = (tag) =>
      Object.fromEntries(
        run('bash', ['scripts/component-versions.sh', tag])
          .trim()
          .split('\n')
          .map((line) => line.split('='))
      )
    const publish = (previous, version) => {
      writeFileSync(log, '')
      run('sh', ['scripts/publish-daemon-if-changed.sh', previous, version, 'prepare'])
      run('sh', ['scripts/publish-daemon-if-changed.sh', previous, 'latest', 'publish'])
      return readFileSync(log, 'utf8')
    }

    write('docker/runtime-sandbox.Dockerfile', 'FROM scratch\nLABEL revision="new"\n')
    commit('v1.0.1')
    assert.equal(components('v1.0.1').runtimeSandbox, 'v1.0.1')
    assert.equal(components('v1.0.1').runtimeSandboxFull, 'v1.0.1')
    assert.equal(components('v1.0.1').daemon, 'v1.0.0')
    const imageRelease = publish('v1.0.0', '1.0.1')
    assert.match(imageRelease, /^1\.0\.1\|run build$/m)
    assert.match(imageRelease, /^\|publish --no-git-checks --ignore-scripts --tag latest$/m)

    write('packages/web/src/page.ts', 'export const page = "new"\n')
    commit('v1.0.2')
    assert.equal(components('v1.0.2').runtimeSandbox, 'v1.0.1')
    assert.equal(components('v1.0.2').runtimeSandboxFull, 'v1.0.1')
    assert.equal(publish('v1.0.1', '1.0.2'), '')

    write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n# a dependency changed\n')
    commit('v1.0.3')
    assert.equal(components('v1.0.3').runtimeSandbox, 'v1.0.3')
    assert.equal(components('v1.0.3').runtimeSandboxFull, 'v1.0.3')
    assert.match(publish('v1.0.2', '1.0.3'), /^1\.0\.3\|run build$/m)

    write('docker/runtime-sandbox-base.Dockerfile', 'FROM scratch\nLABEL dependency="updated"\n')
    commit('v1.0.4')
    assert.equal(components('v1.0.4').runtimeSandbox, 'v1.0.3')
    assert.equal(components('v1.0.4').runtimeSandboxFull, 'v1.0.3')
    assert.equal(publish('v1.0.3', '1.0.4'), '')

    write('docker/runtime-sandbox.Dockerfile', `FROM registry.example.test/runtime-base@sha256:${'a'.repeat(64)}\n`)
    commit('v1.0.5')
    assert.equal(components('v1.0.5').runtimeSandbox, 'v1.0.5')
    assert.equal(components('v1.0.5').runtimeSandboxFull, 'v1.0.5')
    assert.match(publish('v1.0.4', '1.0.5'), /^1\.0\.5\|run build$/m)
  }
)

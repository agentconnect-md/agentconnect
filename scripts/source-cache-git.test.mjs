import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import {
  honorsNoLazyFetch,
  NO_LAZY_FETCH_FLOOR,
  parseGitVersion,
  SOURCE_CACHE_GIT_PROBE
} from '../docker/runtime-sandbox/source-cache-git.mjs'

const v = (text) => parseGitVersion(`git version ${text}`)

test('parseGitVersion reads Debian and Apple output and defaults a missing patch to 0', () => {
  assert.deepEqual(parseGitVersion('git version 2.39.5\n'), { major: 2, minor: 39, patch: 5 })
  assert.deepEqual(parseGitVersion('git version 2.54.0 (Apple Git-157)'), { major: 2, minor: 54, patch: 0 })
  assert.deepEqual(parseGitVersion('git version 2.50'), { major: 2, minor: 50, patch: 0 })
  assert.throws(() => parseGitVersion('nope'), /unexpected git --version output/)
})

test('honorsNoLazyFetch matches the 2024-05 security-release floor', () => {
  for (const below of ['1.9.0', '2.38.0', '2.39.3', '2.40.1', '2.41.0', '2.42.1', '2.43.3', '2.44.0', '2.45.0']) {
    assert.equal(honorsNoLazyFetch(v(below)), false, below)
  }
  for (const at of [
    '2.39.4',
    '2.39.5',
    '2.40.2',
    '2.41.1',
    '2.42.2',
    '2.43.4',
    '2.44.1',
    '2.45.1',
    '2.46.0',
    '2.50.0'
  ]) {
    assert.equal(honorsNoLazyFetch(v(at)), true, at)
  }
  assert.equal(honorsNoLazyFetch(v('3.0.0')), true)
  assert.match(NO_LAZY_FETCH_FLOOR, /2\.39\.4.*2\.45\.1\+/)
})

test('the probe bundles refs/heads/main and reads every ref under refs/bundles', () => {
  assert.match(SOURCE_CACHE_GIT_PROBE, /bundle create "\$tmp\/blobless\.bundle" --filter=blob:none refs\/heads\/main/)
  assert.match(SOURCE_CACHE_GIT_PROBE, /bundle list-heads/)
  assert.match(SOURCE_CACHE_GIT_PROBE, /for-each-ref --format='%\(objectname\)' refs\/bundles/)
  assert.match(SOURCE_CACHE_GIT_PROBE, /fsck --connectivity-only/)
  // Git 2.50 imports refs/bundles/heads/<b>, so a fixed refs/bundles/<b> name falsely fails.
  assert.doesNotMatch(SOURCE_CACHE_GIT_PROBE, /rev-parse refs\/bundles\//)
})

const hostGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
const hostVersion = hostGit ? spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout : ''
const skip = !hostGit
  ? 'git is not installed'
  : process.platform === 'win32'
    ? 'the probe is POSIX sh'
    : !honorsNoLazyFetch(parseGitVersion(hostVersion))
      ? `host ${hostVersion.trim()} is below the GIT_NO_LAZY_FETCH floor`
      : false

/** Runs the probe with an optional `git` wrapper placed first on PATH. */
function runProbe(wrapper) {
  const dir = mkdtempSync(join(tmpdir(), 'ac-source-cache-git-'))
  try {
    let path = process.env.PATH
    if (wrapper) {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'git'), `#!/bin/sh\n${wrapper}\n`)
      chmodSync(join(bin, 'git'), 0o755)
      path = `${bin}${delimiter}${path}`
    }
    return spawnSync('sh', ['-c', SOURCE_CACHE_GIT_PROBE], {
      encoding: 'utf8',
      env: { ...process.env, PATH: path, TMPDIR: dir }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('the probe passes against the host Git', { skip }, () => {
  const result = runProbe()
  assert.equal(result.status, 0, result.stderr)
})

test('the probe fails when --bundle-uri imports nothing', { skip }, () => {
  const strip = `for a do shift; case "$a" in --bundle-uri=*) ;; *) set -- "$@" "$a";; esac; done; exec "${hostGit}" "$@"`
  const result = runProbe(strip)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /imported nothing under refs\/bundles/)
})

test('the probe fails when Git ignores GIT_NO_LAZY_FETCH', { skip }, () => {
  const result = runProbe(`unset GIT_NO_LAZY_FETCH; exec "${hostGit}" "$@"`)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /did not block lazy fetch|still ran the lazy-fetch helper/)
})

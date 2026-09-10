import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('runtime-image-effective.sh', import.meta.url))
const IMAGE = 'ghcr.io/example-org/runtime-sandbox'
const SHIM = `sha256:${'a'.repeat(64)}`
const RECIPE = `sha256:${'b'.repeat(64)}`
const SHIM_LABEL = 'io.agentconnect.shim.digest'
const RECIPE_LABEL = 'io.agentconnect.recipe.digest'
const VERSION_LABEL = 'io.agentconnect.image.version'

// A fake docker answers `buildx imagetools inspect <ref> [--format ...]` from files named after the ref, the way
// the registry would: the labels JSON (or `null`) for a tag that exists, `not found` on stderr and exit 1 otherwise.
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'ac-runtime-effective-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registry = join(root, 'registry')
  const bin = join(root, 'bin')
  mkdirSync(registry)
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'docker'),
    [
      '#!/bin/sh',
      '[ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "unexpected docker call: $*" >&2; exit 64; }',
      'file="$FAKE_REGISTRY/$(printf "%s" "$4" | tr "/:" "__")"',
      '[ -f "$file" ] || { echo "ERROR: $4: not found" >&2; exit 1; }',
      'if [ "$5" = "--format" ]; then cat "$file"; else echo "Name: $4"; fi',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  const publish = (tag, labels) =>
    writeFileSync(
      join(registry, `${IMAGE}:${tag}`.replace(/[/:]/g, '_')),
      `${labels === null ? 'null' : JSON.stringify(labels)}\n`
    )
  const decide = (previous, { version = 'v1.2.3', shim = SHIM, recipe = RECIPE } = {}) => {
    const result = spawnSync('bash', [script, IMAGE, version, previous, shim, recipe], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_REGISTRY: registry }
    })
    assert.equal(result.status, 0, result.stderr)
    const outputs = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => line.split('='))
    )
    return { ...outputs, reason: result.stderr.trim() }
  }
  return { publish, decide }
}

const built = { effective: 'v1.2.3', unchanged: 'false' }

test(
  'a channel without a previous release, or one whose image is gone, builds',
  { skip: process.platform === 'win32' },
  (t) => {
    const { decide } = harness(t)
    const first = decide('')
    assert.deepEqual({ effective: first.effective, unchanged: first.unchanged }, built)
    assert.match(first.reason, /no previous release on this channel/)
    const missing = decide('v1.2.2')
    assert.deepEqual({ effective: missing.effective, unchanged: missing.unchanged }, built)
    assert.match(missing.reason, /v1\.2\.2 is unavailable \(ERROR: .*not found/)
  }
)

test('a previous image without both fingerprint labels builds', { skip: process.platform === 'win32' }, (t) => {
  const { publish, decide } = harness(t)
  publish('v1.2.2', null)
  let result = decide('v1.2.2')
  assert.deepEqual({ effective: result.effective, unchanged: result.unchanged }, built)
  assert.match(result.reason, /carries no fingerprint labels/)
  publish('v1.2.2', { [SHIM_LABEL]: SHIM, [VERSION_LABEL]: 'v1.2.2' })
  result = decide('v1.2.2')
  assert.deepEqual({ effective: result.effective, unchanged: result.unchanged }, built)
  assert.match(result.reason, /carries no fingerprint labels/)
})

test('a changed shim payload or a changed recipe builds', { skip: process.platform === 'win32' }, (t) => {
  const { publish, decide } = harness(t)
  publish('v1.2.2', { [SHIM_LABEL]: SHIM, [RECIPE_LABEL]: RECIPE, [VERSION_LABEL]: 'v1.2.2' })
  const shim = decide('v1.2.2', { shim: `sha256:${'c'.repeat(64)}` })
  assert.deepEqual({ effective: shim.effective, unchanged: shim.unchanged }, built)
  assert.match(shim.reason, /shim payload changed since v1\.2\.2/)
  const recipe = decide('v1.2.2', { recipe: `sha256:${'d'.repeat(64)}` })
  assert.deepEqual({ effective: recipe.effective, unchanged: recipe.unchanged }, built)
  assert.match(recipe.reason, /image recipe changed since v1\.2\.2/)
})

test('matching digests alias to the build the previous tag points at', { skip: process.platform === 'win32' }, (t) => {
  const { publish, decide } = harness(t)
  // v1.2.2 was itself an alias: it shares the config, and so the version label, of the v1.2.0 build.
  publish('v1.2.0', { [SHIM_LABEL]: SHIM, [RECIPE_LABEL]: RECIPE, [VERSION_LABEL]: 'v1.2.0' })
  publish('v1.2.2', { [SHIM_LABEL]: SHIM, [RECIPE_LABEL]: RECIPE, [VERSION_LABEL]: 'v1.2.0' })
  const result = decide('v1.2.2')
  assert.deepEqual(
    { effective: result.effective, unchanged: result.unchanged },
    { effective: 'v1.2.0', unchanged: 'true' }
  )
  assert.match(result.reason, /unchanged since v1\.2\.0/)
})

test(
  'without a usable version label the previous tag itself is the effective version',
  { skip: process.platform === 'win32' },
  (t) => {
    const { publish, decide } = harness(t)
    publish('v1.2.2', { [SHIM_LABEL]: SHIM, [RECIPE_LABEL]: RECIPE })
    let result = decide('v1.2.2')
    assert.deepEqual(
      { effective: result.effective, unchanged: result.unchanged },
      { effective: 'v1.2.2', unchanged: 'true' }
    )
    publish('v1.2.2', { [SHIM_LABEL]: SHIM, [RECIPE_LABEL]: RECIPE, [VERSION_LABEL]: 'v1.1.9' })
    result = decide('v1.2.2')
    assert.deepEqual(
      { effective: result.effective, unchanged: result.unchanged },
      { effective: 'v1.2.2', unchanged: 'true' }
    )
    assert.match(result.reason, /::warning::.*v1\.1\.9 is unavailable/)
  }
)

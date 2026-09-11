import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('runtime-image-fingerprint.sh', import.meta.url))
const DIGEST = `sha256:${'a'.repeat(64)}`
const DOCKERFILE =
  'ARG BASE=registry.example.test/base@sha256:' + 'b'.repeat(64) + '\nFROM ${BASE}\nCOPY /out/ /opt/x/\n'

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'ac-runtime-fingerprint-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const assets = join(root, 'runtime-sandbox')
  mkdirSync(assets)
  writeFileSync(join(assets, 'install.sh'), 'npm install --global example-runtime@1.0.0\n')
  const fingerprint = ({
    digest = `${DIGEST}\n`,
    dockerfile = DOCKERFILE,
    target = 'runtime-sandbox',
    platforms = 'linux/amd64',
    args = '',
    contexts = ''
  } = {}) => {
    writeFileSync(join(root, 'payload-digest'), digest)
    writeFileSync(join(root, 'Dockerfile'), dockerfile)
    const result = spawnSync(
      'bash',
      [script, join(root, 'payload-digest'), join(root, 'Dockerfile'), target, platforms, args, contexts],
      { encoding: 'utf8' }
    )
    return result
  }
  const outputs = (result) => {
    assert.equal(result.status, 0, result.stderr)
    const lines = result.stdout.split('\n')
    const value = (key) => lines.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)
    const start = lines.indexOf('labels<<EOF')
    return { shim: value('shim'), recipe: value('recipe'), labels: lines.slice(start + 1, lines.indexOf('EOF', start)) }
  }
  return { fingerprint, outputs, assets }
}

test('the payload digest is read as is and both digests become labels', { skip: process.platform === 'win32' }, (t) => {
  const { fingerprint, outputs } = harness(t)
  const result = outputs(fingerprint())
  assert.equal(result.shim, DIGEST)
  assert.match(result.recipe, /^sha256:[0-9a-f]{64}$/)
  assert.deepEqual(result.labels, [
    `io.agentconnect.shim.digest=${DIGEST}`,
    `io.agentconnect.recipe.digest=${result.recipe}`
  ])
})

test(
  'the recipe follows the Dockerfile and the build inputs, never the payload',
  { skip: process.platform === 'win32' },
  (t) => {
    const { fingerprint, outputs, assets } = harness(t)
    const base = outputs(fingerprint())
    assert.equal(outputs(fingerprint()).recipe, base.recipe)
    assert.equal(outputs(fingerprint({ digest: `sha256:${'c'.repeat(64)}\n` })).recipe, base.recipe)
    const bumped = DOCKERFILE.replace('b'.repeat(64), 'd'.repeat(64))
    assert.notEqual(outputs(fingerprint({ dockerfile: bumped })).recipe, base.recipe)
    assert.notEqual(outputs(fingerprint({ platforms: 'linux/amd64,linux/arm64' })).recipe, base.recipe)
    assert.notEqual(outputs(fingerprint({ args: 'RUNTIME_SANDBOX_BASE=other' })).recipe, base.recipe)
    assert.notEqual(outputs(fingerprint({ contexts: 'base=docker-image://other' })).recipe, base.recipe)
    assert.notEqual(outputs(fingerprint({ target: 'runtime-sandbox-full' })).recipe, base.recipe)
    writeFileSync(join(assets, 'install.sh'), 'npm install --global example-runtime@1.0.1\n')
    assert.notEqual(outputs(fingerprint()).recipe, base.recipe)
  }
)

test(
  'a file that holds no digest fails instead of labelling the image with it',
  { skip: process.platform === 'win32' },
  (t) => {
    const { fingerprint } = harness(t)
    for (const digest of ['', 'sha256:short\n', 'not a digest\n']) {
      const result = fingerprint({ digest })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /::error::.*holds no payload digest/)
    }
  }
)

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { treeDigest } from './tree-digest.mjs'

const script = fileURLToPath(new URL('tree-digest.mjs', import.meta.url))

// Shaped like the runtime payload: read-only files under read-only directories, so directory modes are applied last
// (a 0555 directory refuses new entries) and reset before removal.
const payload = () => ({
  files: {
    'shim/index.js': ['export const shim = 1\n', 0o444],
    'shim/skills/package.json': ['{"name":"skills"}\n', 0o444],
    'pathbin/gh': ['#!/bin/sh\nexec gh "$@"\n', 0o555]
  },
  dirs: { shim: 0o555, 'shim/skills': 0o555, pathbin: 0o555 }
})

function writeTree(root, { files, dirs }, { mtime = new Date('2020-01-01T00:00:00Z'), order = 1 } = {}) {
  const names = Object.keys(files)
  if (order < 0) names.reverse()
  for (const name of names) {
    const [content, mode] = files[name]
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content, { mode })
    utimesSync(join(root, name), mtime, mtime)
  }
  for (const [name, mode] of Object.entries(dirs)) chmodSync(join(root, name), mode)
}

function openTree(root, { dirs }) {
  for (const name of Object.keys(dirs)) chmodSync(join(root, name), 0o755)
}

function fixture(t, spec, options) {
  const root = mkdtempSync(join(tmpdir(), 'ac-tree-digest-'))
  writeTree(root, spec, options)
  t.after(() => {
    openTree(root, spec)
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

test(
  'identical content hashes equal regardless of mtimes, write order and location',
  { skip: process.platform === 'win32' },
  (t) => {
    const a = fixture(t, payload(), { mtime: new Date('2020-01-01T00:00:00Z'), order: 1 })
    const b = fixture(t, payload(), { mtime: new Date('2031-06-15T12:34:56Z'), order: -1 })
    assert.match(treeDigest(a), /^sha256:[0-9a-f]{64}$/)
    assert.equal(treeDigest(a), treeDigest(b))
  }
)

test('a file mode change alone changes the digest', { skip: process.platform === 'win32' }, (t) => {
  const base = fixture(t, payload())
  const changed = payload()
  changed.files['shim/index.js'][1] = 0o644
  assert.notEqual(treeDigest(fixture(t, changed)), treeDigest(base))
})

test('a directory mode change alone changes the digest', { skip: process.platform === 'win32' }, (t) => {
  const base = fixture(t, payload())
  const changed = payload()
  changed.dirs.pathbin = 0o755
  assert.notEqual(treeDigest(fixture(t, changed)), treeDigest(base))
})

test('content, names and extra entries all change the digest', { skip: process.platform === 'win32' }, (t) => {
  const base = treeDigest(fixture(t, payload()))
  const edited = payload()
  edited.files['shim/index.js'][0] = 'export const shim = 2\n'
  assert.notEqual(treeDigest(fixture(t, edited)), base)
  const renamed = payload()
  renamed.files['shim/main.js'] = renamed.files['shim/index.js']
  delete renamed.files['shim/index.js']
  assert.notEqual(treeDigest(fixture(t, renamed)), base)
  const extra = payload()
  extra.files['shim/index.js.map'] = ['{}\n', 0o444]
  assert.notEqual(treeDigest(fixture(t, extra)), base)
})

test('a symlink is hashed by its target', { skip: process.platform === 'win32' }, (t) => {
  const spec = { files: { 'bin/real': ['x\n', 0o555] }, dirs: {} }
  const a = fixture(t, spec)
  const b = fixture(t, spec)
  symlinkSync('real', join(a, 'bin/link'))
  symlinkSync('other', join(b, 'bin/link'))
  assert.notEqual(treeDigest(a), treeDigest(b))
  const c = fixture(t, spec)
  symlinkSync('real', join(c, 'bin/link'))
  assert.equal(treeDigest(a), treeDigest(c))
})

test('the CLI prints the digest and rejects a missing argument', { skip: process.platform === 'win32' }, (t) => {
  const root = fixture(t, payload())
  assert.equal(execFileSync(process.execPath, [script, root], { encoding: 'utf8' }), `${treeDigest(root)}\n`)
  const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /usage/)
})

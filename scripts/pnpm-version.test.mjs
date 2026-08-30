import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The workflows pin `version:` so `pnpm/action-setup` installs once instead of fetching npm's
// latest and then downloading the pinned one as well. That pin duplicates what `packageManager`
// already declares, and a duplicate that can drift is only safe if something notices.
const declared = JSON.parse(readFileSync('package.json', 'utf8')).packageManager
const expected = declared.replace(/^pnpm@/, '')

test('every workflow pins the pnpm version package.json declares', () => {
  assert.match(declared, /^pnpm@\d+\.\d+\.\d+$/)
  const dir = '.github/workflows'
  const offenders = []
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
    const body = readFileSync(join(dir, name), 'utf8')
    const uses = body.split('\n').filter((line) => line.includes('pnpm/action-setup')).length
    const pinned = [...body.matchAll(/^\s*version:\s*(\S+)\s*$/gm)].map((m) => m[1])
    const wrong = pinned.filter((v) => /^\d+\.\d+\.\d+$/.test(v) && v !== expected)
    if (uses > 0 && pinned.filter((v) => v === expected).length < uses)
      offenders.push(`${name}: ${uses} uses, ${pinned.filter((v) => v === expected).length} pinned to ${expected}`)
    if (wrong.length) offenders.push(`${name}: pins ${wrong.join(', ')}`)
  }
  assert.deepEqual(offenders, [])
})

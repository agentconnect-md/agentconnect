// `eval:gates` is what CI runs: the three evaluation gates in ONE Vitest invocation instead of
// three. Three processes each paid Vitest startup, config load and transform, and the smallest gate
// could not fill four workers with three files — merging measured 95.5s → 43.3s locally.
//
// The three per-gate scripts stay, because that is how you run one gate while working on it. This
// test is what keeps the merged list honest: add a file to a gate and forget `eval:gates`, and CI
// silently stops covering it. Failing here says so at the seam.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GATES = ['eval:contracts', 'eval:collab:contracts', 'eval:parity']

const scripts = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).scripts

/** The files a `vitest run …` script names, in order. */
function filesOf(script) {
  const raw = scripts[script]
  assert.ok(raw, `missing script: ${script}`)
  assert.ok(raw.startsWith('vitest run '), `${script} is not a plain \`vitest run\`: ${raw}`)
  return raw.slice('vitest run '.length).trim().split(/\s+/)
}

test('eval:gates runs exactly the union of the three gates', () => {
  const union = [...new Set(GATES.flatMap(filesOf))]
  const merged = filesOf('eval:gates')

  // Both directions: a gate file missing from `eval:gates` is uncovered in CI, and an extra entry
  // there is a file no gate claims — usually a rename that left the old path behind.
  assert.deepEqual([...merged].sort(), [...union].sort())
  assert.equal(merged.length, new Set(merged).size, 'eval:gates lists a file twice')
})

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkRuntimeTable, main } from './verify-runtime-table.mjs'

// Shaped like the real k8s-runtimes.json and installed-runtimes.json pair the pool image ships.
const expected = () => [
  { id: 'claude-acp', command: 'claude-agent-acp', args: [] },
  { id: 'codex-acp', command: 'codex-acp', args: [] }
]

const table = () => ({
  runtimes: [
    {
      id: 'claude-acp',
      version: '0.76.0',
      command: 'claude-agent-acp',
      args: [],
      acp: {
        agentName: 'claude-code',
        authMethods: ['claude-login'],
        capabilities: { loadSession: true },
        configOptions: [{ category: 'model', id: 'model', type: 'select', values: ['opus', 'sonnet'] }],
        modes: ['default'],
        protocolVersion: 1,
        sessionProbe: 'ok'
      }
    },
    {
      id: 'codex-acp',
      version: '1.11.0',
      command: 'codex-acp',
      args: [],
      acp: {
        agentName: 'codex',
        authMethods: ['chatgpt'],
        capabilities: { loadSession: false },
        configOptions: [],
        modes: [],
        protocolVersion: 1,
        sessionProbe: 'auth-required'
      }
    }
  ]
})

const withCodex = (mutate) => {
  const published = table()
  mutate(published.runtimes.find((entry) => entry.id === 'codex-acp'))
  return published
}

const check = (overrides = {}) =>
  checkRuntimeTable({
    variant: 'runtime-sandbox',
    published: table(),
    probed: table(),
    expected: expected(),
    ...overrides
  })

test('a table that agrees with its probe and roster passes and lists every runtime', () => {
  assert.deepEqual(check(), { warnings: [], summary: 'claude-acp@0.76.0 acp/1 codex-acp@1.11.0 acp/1' })
})

test('a value roster that moved upstream is a warning, never a failure', () => {
  const probed = table()
  probed.runtimes[0].acp.configOptions[0].values = ['haiku', 'opus']
  const { warnings } = check({ probed })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^claude-acp\.acp\.configOptions\[model\]\.values drifted upstream/)
})

test('a field the image pins failing the probe names the field', () => {
  const probed = withCodex((runtime) => (runtime.version = '1.12.0'))
  assert.throws(
    () => check({ probed }),
    /^Error: the shipped table differs from a fresh probe — codex-acp\.version: published "1\.11\.0", probed "1\.12\.0"$/
  )
})

test('the declared roster must match the published ids exactly', () => {
  assert.throws(
    () => check({ expected: [...expected(), { id: 'dsh-acp', command: 'dsh-acp', args: [] }] }),
    /^Error: runtime-sandbox runtime ids: expected claude-acp, codex-acp, dsh-acp, got claude-acp, codex-acp$/
  )
  const roster = expected().slice(0, 1)
  assert.throws(() => check({ expected: roster }), /expected claude-acp, got claude-acp, codex-acp/)
})

test('an entry must run the executable and arguments the roster declares', () => {
  const rebound = expected()
  rebound[1].args = ['--acp']
  assert.throws(
    () => check({ expected: rebound }),
    /^Error: codex-acp does not use the executable and arguments declared for runtime-sandbox$/
  )
  const renamed = expected()
  renamed[1].command = 'codex'
  assert.throws(() => check({ expected: renamed }), /codex-acp does not use the executable/)
})

test('an entry without an initialize snapshot fails', () => {
  const noProtocol = withCodex((runtime) => delete runtime.acp.protocolVersion)
  assert.throws(
    () => check({ published: noProtocol, probed: noProtocol }),
    /^Error: codex-acp has no ACP protocol version, so the snapshot is not from initialize$/
  )
  for (const capabilities of [undefined, null, 'yes', ['loadSession']]) {
    const broken = withCodex((runtime) => (runtime.acp.capabilities = capabilities))
    assert.throws(
      () => check({ published: broken, probed: broken }),
      /^Error: codex-acp publishes no ACP capabilities object$/
    )
  }
})

test('a table with no runtimes fails instead of passing empty', () => {
  for (const published of [{}, { runtimes: [] }, { runtimes: 'none' }]) {
    assert.throws(() => check({ published }), /the table declares no runtimes, so the daemon would advertise none/)
  }
})

// The CLI is what the build stage runs, so the wiring around the pure check is exercised with a fake generator.
function fixture(probed) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-runtime-table-'))
  const tablePath = join(dir, 'k8s-runtimes.json')
  const expectedPath = join(dir, 'installed-runtimes.json')
  const generatorPath = join(dir, 'generate-runtime-table.mjs')
  writeFileSync(tablePath, JSON.stringify(table()))
  writeFileSync(expectedPath, JSON.stringify(expected()))
  writeFileSync(
    generatorPath,
    `if (process.argv[2] !== '-') throw new Error('expected the print mode')\nprocess.stdout.write(${JSON.stringify(JSON.stringify(probed))})\n`
  )
  return { tablePath, expectedPath, generatorPath }
}

const capture = () => {
  const out = { stdout: '', stderr: '' }
  return {
    out,
    streams: {
      stdout: { write: (text) => (out.stdout += text) },
      stderr: { write: (text) => (out.stderr += text) }
    }
  }
}

test('the CLI prints the roster and its warnings and exits 0 when the table holds', () => {
  const probed = table()
  probed.runtimes[0].acp.configOptions[0].values = ['haiku', 'opus']
  const { tablePath, expectedPath, generatorPath } = fixture(probed)
  const { out, streams } = capture()
  assert.equal(main(['runtime-sandbox', expectedPath, tablePath, generatorPath], streams), 0)
  assert.match(
    out.stdout,
    /^runtime-sandbox runtime table check\n {2}✓ .* — claude-acp@0\.76\.0 acp\/1 codex-acp@1\.11\.0 acp\/1\n/
  )
  assert.match(out.stdout, /\n {2}! claude-acp\.acp\.configOptions\[model\]\.values drifted upstream/)
  assert.equal(out.stderr, '')
})

test('the CLI exits 1 and names the drift when the probe disagrees', () => {
  const { tablePath, expectedPath, generatorPath } = fixture(withCodex((runtime) => (runtime.acp.modes = ['plan'])))
  const { out, streams } = capture()
  assert.equal(main(['runtime-sandbox', expectedPath, tablePath, generatorPath], streams), 1)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /✗ .*codex-acp\.acp\.modes: published \[\], probed \["plan"\]/)
})

test('the CLI refuses an unknown variant or a missing roster path', () => {
  const { out, streams } = capture()
  assert.equal(main(['runtime-sandbox-lite', '/x.json'], streams), 2)
  assert.equal(main(['runtime-sandbox'], streams), 2)
  assert.match(out.stderr, /^usage: verify-runtime-table\.mjs/)
})

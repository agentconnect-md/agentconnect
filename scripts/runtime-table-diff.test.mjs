import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffRuntimeTables } from './runtime-table-diff.mjs'

// Shaped like the real k8s-runtimes.json: two runtimes, one authenticated and one not, each with the
// model option whose value roster the image cannot pin.
const baseline = () => ({
  runtimes: [
    {
      id: 'claude-acp',
      version: '1.4.2',
      command: 'claude-agent-acp',
      args: [],
      acp: {
        agentName: 'claude-code',
        authMethods: ['claude-login'],
        capabilities: { loadSession: true, promptCapabilities: { image: true } },
        configOptions: [{ category: 'model', id: 'model', type: 'select', values: ['opus', 'sonnet'] }],
        modes: ['acceptEdits', 'default'],
        protocolVersion: 1,
        sessionProbe: 'ok'
      }
    },
    {
      id: 'opencode',
      version: '0.15.7',
      command: 'opencode',
      args: ['acp'],
      acp: {
        agentName: 'opencode',
        authMethods: [],
        capabilities: { loadSession: false },
        configOptions: [
          { category: 'model', id: 'model', type: 'select', values: ['hy3-free', 'nemotron-3.5-lightning-free'] },
          { category: 'permission', id: 'permission', type: 'select', values: ['ask', 'edit'] }
        ],
        modes: [],
        protocolVersion: 1,
        sessionProbe: 'auth-required'
      }
    }
  ]
})

const withOpencode = (mutate) => {
  const table = baseline()
  mutate(table.runtimes.find((entry) => entry.id === 'opencode'))
  return table
}

test('two probes of the same image agree', () => {
  assert.deepEqual(diffRuntimeTables(baseline(), baseline()), { failures: [], warnings: [] })
})

// The v1.41.0 release failure: a cache-hit build shipped a table hours older than the probe, and the
// only difference was a free-model roster opencode fetches upstream.
test('a value roster that moved upstream warns and does not fail', () => {
  const probed = withOpencode((runtime) => {
    runtime.acp.configOptions[0].values = ['ling-3.0-tiny-free', 'longcat-2.0-free', 'north-mini-code-free']
  })
  const { failures, warnings } = diffRuntimeTables(baseline(), probed)
  assert.deepEqual(failures, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /^opencode\.acp\.configOptions\[model\]\.values drifted upstream/)
  assert.match(warnings[0], /added ling-3\.0-tiny-free, longcat-2\.0-free, north-mini-code-free/)
  assert.match(warnings[0], /removed hy3-free, nemotron-3\.5-lightning-free/)
})

test('every field the image pins still fails the build, naming the field and both values', () => {
  const cases = [
    [
      'version',
      (runtime) => (runtime.version = '0.16.0'),
      /^opencode\.version: published "0\.15\.7", probed "0\.16\.0"$/
    ],
    ['command', (runtime) => (runtime.command = 'opencode-next'), /^opencode\.command: /],
    ['args', (runtime) => (runtime.args = ['acp', '--json']), /^opencode\.args: published \["acp"\]/],
    [
      'protocolVersion',
      (runtime) => (runtime.acp.protocolVersion = 2),
      /^opencode\.acp\.protocolVersion: published 1, probed 2$/
    ],
    ['agentName', (runtime) => (runtime.acp.agentName = 'opencode-acp'), /^opencode\.acp\.agentName: /],
    ['authMethods', (runtime) => (runtime.acp.authMethods = ['api-key']), /^opencode\.acp\.authMethods: /],
    [
      'capabilities',
      (runtime) => (runtime.acp.capabilities.loadSession = true),
      /^opencode\.acp\.capabilities\.loadSession: published false, probed true$/
    ],
    ['modes', (runtime) => (runtime.acp.modes = ['default']), /^opencode\.acp\.modes: /],
    [
      'sessionProbe',
      (runtime) => (runtime.acp.sessionProbe = 'ok'),
      /^opencode\.acp\.sessionProbe: published "auth-required", probed "ok"$/
    ],
    [
      'option category',
      (runtime) => (runtime.acp.configOptions[0].category = 'models'),
      /^opencode\.acp\.configOptions\[model\]\.category: published "model", probed "models"$/
    ],
    [
      'option type',
      (runtime) => (runtime.acp.configOptions[0].type = 'string'),
      /^opencode\.acp\.configOptions\[model\]\.type: /
    ],
    [
      'option roster',
      (runtime) => runtime.acp.configOptions.pop(),
      /^opencode\.acp\.configOptions: published only permission, probed only none$/
    ]
  ]
  for (const [name, mutate, expected] of cases) {
    const { failures, warnings } = diffRuntimeTables(baseline(), withOpencode(mutate))
    assert.equal(failures.length, 1, `${name} produced ${failures.length} failures: ${failures.join('; ')}`)
    assert.match(failures[0], expected)
    assert.deepEqual(warnings, [])
  }
})

test('a runtime that appears or disappears fails', () => {
  const shorter = baseline()
  shorter.runtimes.pop()
  assert.deepEqual(diffRuntimeTables(baseline(), shorter).failures, [
    'runtime ids: published only opencode, probed only none'
  ])
  assert.deepEqual(diffRuntimeTables(shorter, baseline()).failures, [
    'runtime ids: published only none, probed only opencode'
  ])
})

// The generator's own output is the contract, so a shape that is not it must fail rather than be diffed.
test('a table with no runtimes array fails instead of passing empty', () => {
  const { failures } = diffRuntimeTables({}, baseline())
  assert.equal(failures.length, 1)
  assert.match(failures[0], /^runtimes: published null, probed \[/)
})

// A field the generator adds later is pinned without this module listing it.
test('an unlisted field is compared exactly', () => {
  const probed = withOpencode((runtime) => (runtime.acp.slashCommands = ['/init']))
  const { failures } = diffRuntimeTables(baseline(), probed)
  assert.deepEqual(failures, ['opencode.acp.slashCommands: published null, probed ["/init"]'])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { planPackages, publishPackages, readPublishedVersion } from './publish-npm.mjs'

test('publication planning skips unchanged inputs and includes only required packages and app architectures', async () => {
  const pins = {
    '@agentconnect.md/computer-darwin-arm64': '2.6.0',
    '@agentconnect.md/computer-darwin-x64': '2.6.0'
  }
  const options = {
    readVersion: async (_name, selector) => (selector === 'latest' ? '2.6.0' : undefined),
    readPins: async () => pins,
    changed: () => false,
    check: () => false
  }
  const unchanged = await planPackages('v2.7.0', options)
  assert.deepEqual(unchanged, { version: '2.7.0', channel: 'latest', apps: [], packages: [], pins })
  await publishPackages('v2.7.0', {
    ...options,
    built: () => true,
    execute: () => assert.fail('Unchanged packages must not build or publish')
  })

  const codeOnly = await planPackages('v2.7.0', { ...options, check: (component) => component === 'computer' })
  assert.deepEqual(codeOnly.apps, [])
  assert.deepEqual(codeOnly.packages, [{ component: 'computer', previousTag: 'v2.6.0' }])
  assert.deepEqual(codeOnly.pins, pins)

  const appChange = {
    ...options,
    changed: () => true,
    check: (_component, previousTag) => previousTag === ''
  }
  const changed = await planPackages('v2.7.0', appChange)
  assert.deepEqual(changed.apps, ['arm64', 'x64'])
  assert.deepEqual(changed.packages, [{ component: 'computer', previousTag: '' }])
  assert.deepEqual(Object.values(changed.pins), ['2.7.0', '2.7.0'])
  assert.deepEqual(await planPackages('v2.7.0', { ...appChange, buildApps: () => false }), unchanged)

  const first = await planPackages('v2.7.0', { ...appChange, readVersion: async () => undefined })
  assert.deepEqual(first.apps, ['arm64', 'x64'])
  assert.deepEqual(
    first.packages.map(({ component }) => component),
    ['daemon', 'cli', 'setup', 'computer']
  )
  assert.ok(first.packages.every(({ previousTag }) => previousTag === ''))
})

test('planning a partial retry uses each package last published on its channel and rebuilds only the missing app', async () => {
  const baselines = []
  const plan = await planPackages('v2.7.0-rc.7', {
    readVersion: async (name, selector) => {
      const current = name.endsWith('arm64') || name.endsWith('/daemon') ? '2.7.0-rc.7' : '2.7.0-rc.3'
      return selector === 'rc' || selector === current ? current : undefined
    },
    readPins: async () => ({}),
    changed: () => true,
    check: (component, previousTag) => {
      baselines.push([component, previousTag])
      return true
    }
  })
  assert.equal(plan.channel, 'rc')
  assert.deepEqual(plan.apps, ['x64'])
  assert.deepEqual(baselines, [
    ['cli', 'v2.7.0-rc.3'],
    ['setup', 'v2.7.0-rc.3'],
    ['computer', '']
  ])
  assert.deepEqual(Object.values(plan.pins), ['2.7.0-rc.7', '2.7.0-rc.7'])
})

test('a partial npm retry skips completed packages and compares against each package last published on npm', async () => {
  const current = new Map([
    ['daemon', '1.0.0'],
    ['cli', '1.0.0'],
    ['setup', '0.9.0'],
    ['computer', '1.0.0']
  ])
  const calls = []
  let failSetup = true
  const options = {
    check: () => true,
    built: () => false,
    readPins: async () => ({}),
    readVersion: async (name, selector) => {
      const version = current.get(name.split('/')[1])
      return selector === 'latest' || selector === version ? version : undefined
    },
    execute: (script, args) => {
      const component = /publish-(.+)-if-changed/.exec(script)[1]
      calls.push([component, ...args])
      if (args[2] !== 'publish') return
      if (component === 'setup' && failSetup) {
        failSetup = false
        throw new Error('registry unavailable')
      }
      current.set(component, '1.0.1')
    }
  }

  await assert.rejects(publishPackages('v1.0.1', options), /registry unavailable/)
  await publishPackages('v1.0.1', options)

  assert.deepEqual(calls, [
    ['daemon', 'v1.0.0', '1.0.1', 'prepare'],
    ['daemon', 'v1.0.0', 'latest', 'publish'],
    ['cli', 'v1.0.0', '1.0.1', 'prepare'],
    ['cli', 'v1.0.0', 'latest', 'publish'],
    ['setup', 'v0.9.0', '1.0.1', 'prepare'],
    ['setup', 'v0.9.0', 'latest', 'publish'],
    ['setup', 'v0.9.0', '1.0.1', 'prepare'],
    ['setup', 'v0.9.0', 'latest', 'publish'],
    ['computer', 'v1.0.0', '1.0.1', 'prepare', '{}'],
    ['computer', 'v1.0.0', 'latest', 'publish']
  ])
})

test('retrying an older release cannot move the npm channel backwards', async () => {
  for (const [tag, channel, current] of [
    ['v1.0.0-rc.9', 'rc', '1.0.0-rc.10'],
    ['v1.0.9', 'latest', '1.0.10']
  ]) {
    await publishPackages(tag, {
      check: () => true,
      readVersion: async (_name, selector) => (selector === channel ? current : undefined),
      execute: () => assert.fail('An older retry must not publish')
    })
  }
})

test('registry errors fail publication instead of treating an unknown version as absent', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }))
  await assert.rejects(readPublishedVersion('@example/package', 'latest'), /registry returned 503/)
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
  assert.equal(await readPublishedVersion('@example/package', '1.0.0'), undefined)
})

test('a package with no release on a channel publishes with no baseline, so its first release always builds', async () => {
  const calls = []
  await publishPackages('v2.6.0', {
    check: () => true,
    readVersion: async (name, selector) =>
      name.endsWith('/computer') || name.includes('darwin') || selector !== 'latest' ? undefined : '2.5.0',
    execute: (script, args) => calls.push([/publish-(.+)-if-changed/.exec(script)[1], ...args]),
    built: () => false
  })
  assert.deepEqual(
    calls.filter(([component]) => component === 'computer'),
    [
      ['computer', '', '2.6.0', 'prepare', '{}'],
      ['computer', '', 'latest', 'publish']
    ]
  )
})

test('the computer package pins each macOS app, rebuilt only when its recipe changed so grants survive', async () => {
  const run = async ({ published, changed, built = () => true }) => {
    const calls = []
    await publishPackages('v2.7.0', {
      check: () => true,
      readVersion: async (name, selector) => {
        const version = name.includes('darwin') ? published[name.split('-').pop()] : '2.6.0'
        return selector === 'latest' || selector === version ? version : undefined
      },
      readPins: async () => ({}),
      execute: (script, args) => calls.push([script.replace(/^scripts\//, ''), ...args]),
      changed: (tag, paths) => {
        assert.deepEqual(paths, [
          'packages/computer/scripts/build-macos-app.mjs',
          'packages/computer/macos/menubar.swift'
        ])
        return changed(tag)
      },
      built
    })
    return calls
  }
  const pins = (calls) => calls.find(([script, , , mode]) => script.includes('computer-if') && mode === 'prepare')[4]

  const rebuilt = await run({ published: { arm64: '2.6.0', x64: '2.6.0' }, changed: () => true })
  assert.deepEqual(rebuilt.slice(0, 4), [
    ['publish-computer-app.sh', 'arm64', '2.7.0', 'prepare'],
    ['publish-computer-app.sh', 'arm64', 'latest', 'publish'],
    ['publish-computer-app.sh', 'x64', '2.7.0', 'prepare'],
    ['publish-computer-app.sh', 'x64', 'latest', 'publish']
  ])
  assert.deepEqual(JSON.parse(pins(rebuilt)), {
    '@agentconnect.md/computer-darwin-arm64': '2.7.0',
    '@agentconnect.md/computer-darwin-x64': '2.7.0'
  })

  const kept = await run({ published: { arm64: '2.5.0', x64: '2.6.0' }, changed: (tag) => tag === 'v2.6.0' })
  assert.deepEqual(
    kept.filter(([script]) => script.includes('computer-app')),
    [
      ['publish-computer-app.sh', 'x64', '2.7.0', 'prepare'],
      ['publish-computer-app.sh', 'x64', 'latest', 'publish']
    ]
  )
  assert.deepEqual(JSON.parse(pins(kept)), {
    '@agentconnect.md/computer-darwin-arm64': '2.5.0',
    '@agentconnect.md/computer-darwin-x64': '2.7.0'
  })

  // A release that did not build the apps pins what is published, or nothing before the first app release.
  const unbuilt = await run({ published: { arm64: '2.6.0' }, changed: () => true, built: () => false })
  assert.ok(!unbuilt.some(([script]) => script.includes('computer-app')))
  assert.deepEqual(JSON.parse(pins(unbuilt)), { '@agentconnect.md/computer-darwin-arm64': '2.6.0' })
})

test('a computer whose app pins moved republishes even when its bundle inputs did not change', async () => {
  const run = async (publishedPins) => {
    const calls = []
    await publishPackages('v2.7.0-rc.7', {
      check: () => true,
      readVersion: async (name, selector) => {
        if (name.includes('darwin')) return selector === 'rc' ? '2.7.0-rc.7' : undefined
        return selector === 'rc' ? '2.7.0-rc.3' : undefined
      },
      readPins: async (name, version) => {
        assert.deepEqual([name, version], ['@agentconnect.md/computer', '2.7.0-rc.3'])
        return publishedPins
      },
      execute: (script, args) => calls.push([/publish-(.+)-if-changed/.exec(script)?.[1], ...args]),
      built: () => false
    })
    return calls.filter(([component]) => component === 'computer').map(([, previousTag]) => previousTag)
  }
  const pinned = {
    '@agentconnect.md/computer-darwin-arm64': '2.7.0-rc.7',
    '@agentconnect.md/computer-darwin-x64': '2.7.0-rc.7'
  }

  assert.deepEqual(await run({}), ['', ''])
  assert.deepEqual(await run(pinned), ['v2.7.0-rc.3', 'v2.7.0-rc.3'])
})

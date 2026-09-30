import assert from 'node:assert/strict'
import { test } from 'node:test'

import { publishPackages, readPublishedVersion } from './publish-npm.mjs'

test('a partial npm retry skips completed packages and compares against each package last published on npm', async () => {
  const current = new Map([
    ['daemon', '1.0.0'],
    ['cli', '1.0.0'],
    ['setup', '0.9.0']
  ])
  const calls = []
  let failSetup = true
  const options = {
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
    ['setup', 'v0.9.0', 'latest', 'publish']
  ])
})

test('retrying an older release cannot move the npm channel backwards', async () => {
  for (const [tag, channel, current] of [
    ['v1.0.0-rc.9', 'rc', '1.0.0-rc.10'],
    ['v1.0.9', 'latest', '1.0.10']
  ]) {
    await publishPackages(tag, {
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

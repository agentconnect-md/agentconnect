import assert from 'node:assert/strict'
import { test } from 'node:test'

import { publish, retargetRelease } from './semantic-release-github.js'

test('the published release is targeted at the default branch, not the release branch', () => {
  const context = { branch: { name: 'release', type: 'release', main: true, channel: undefined }, other: 'kept' }
  const retargeted = retargetRelease(context)

  assert.equal(retargeted.branch.name, 'main')
  assert.equal(retargeted.other, 'kept')
  // prerelease and make_latest are decided by these two fields, so renaming the branch must leave them alone.
  assert.equal(retargeted.branch.type, 'release')
  assert.equal(retargeted.branch.main, true)
  assert.equal(context.branch.name, 'release')
})

test('a prerelease publishes no GitHub Release', async () => {
  const logged = []
  const result = await publish(
    {},
    {
      branch: { name: 'main', type: 'prerelease', prerelease: 'rc' },
      nextRelease: { gitTag: 'v1.1.0-rc.1' },
      logger: { log: (...args) => logged.push(args) }
    }
  )

  assert.equal(result, undefined)
  assert.equal(logged.length, 1)
})

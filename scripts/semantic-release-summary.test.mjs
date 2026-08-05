import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import releaseConfig from '../release.config.js'
import { success } from './semantic-release-summary.js'

test('release summary writes commit-derived notes literally', async (t) => {
  assert.ok(releaseConfig.plugins.includes('./scripts/semantic-release-summary.js'))
  const daemonPublisher = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[1]?.prepareCmd?.includes('publish-daemon-if-changed')
  )
  assert.ok(daemonPublisher)
  assert.equal(daemonPublisher[1].successCmd, undefined)
  const setupPublisher = releaseConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[1]?.prepareCmd?.includes('publish-setup-if-changed')
  )
  assert.ok(setupPublisher)

  const dir = await mkdtemp(join(tmpdir(), 'agentconnect-release-summary-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const outputPath = join(dir, 'output')
  const summaryPath = join(dir, 'summary')
  const markerPath = join(dir, 'should-not-run')
  const notes = `__ACP_NOTES__\ntouch "${markerPath}"\n\`echo should-not-run\``

  await success(
    {},
    {
      env: {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath
      },
      nextRelease: {
        gitTag: 'v1.2.3',
        notes
      }
    }
  )

  assert.equal(await readFile(outputPath, 'utf8'), 'version=v1.2.3\n')
  assert.equal(await readFile(summaryPath, 'utf8'), `### 🚀 Released v1.2.3\n\n${notes}\n`)
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' })
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import releaseConfig from '../release.config.js'
import { analyzeCommits, success } from './semantic-release-summary.js'

test('a rerun resumes only the same commit and release channel without requesting another release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentconnect-release-retry-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cases = [
    { name: 'candidate retry', attempt: '2', head: 'current', channel: 'main', channels: ['main'], resume: true },
    { name: 'stable retry', attempt: '2', head: 'current', channels: [null], resume: true },
    { name: 'first attempt', attempt: '1', head: 'current', channel: 'main', channels: ['main'] },
    { name: 'another commit', attempt: '2', head: 'older', channel: 'main', channels: ['main'] },
    { name: 'another channel', attempt: '2', head: 'current', channel: 'main', channels: [null] },
    { name: 'no previous release', attempt: '2' }
  ]
  for (const example of cases) {
    const outputPath = join(dir, example.name)
    const gitTag = example.channel === 'main' ? 'v1.2.3-rc.4' : 'v1.2.3'
    const result = await analyzeCommits(
      {},
      {
        env: { GITHUB_OUTPUT: outputPath, GITHUB_RUN_ATTEMPT: example.attempt, GITHUB_SHA: 'current' },
        branch: { channel: example.channel },
        lastRelease: { gitTag, gitHead: example.head, channels: example.channels }
      }
    )
    assert.equal(result, undefined, example.name)
    if (example.resume) assert.equal(await readFile(outputPath, 'utf8'), `version=${gitTag}\n`, example.name)
    else await assert.rejects(readFile(outputPath), { code: 'ENOENT' }, example.name)
  }
})

test('release summary writes commit-derived notes literally', async (t) => {
  assert.ok(releaseConfig.plugins.includes('./scripts/semantic-release-summary.js'))
  assert.ok(releaseConfig.plugins.every((plugin) => !Array.isArray(plugin) || plugin[0] !== '@semantic-release/exec'))

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
  assert.equal(await readFile(summaryPath, 'utf8'), `### 🚀 Release v1.2.3\n\n${notes}\n`)
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' })
})

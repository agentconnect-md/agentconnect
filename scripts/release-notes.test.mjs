import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

import releaseConfig from '../release.config.js'

const requireFromSemanticRelease = createRequire(import.meta.resolve('semantic-release'))
const generatorPath = requireFromSemanticRelease.resolve('@semantic-release/release-notes-generator')
const { generateNotes } = await import(pathToFileURL(generatorPath))

const [, releaseNotesConfig] = releaseConfig.plugins.find(
  (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/release-notes-generator'
)

test('release notes retain configured commit sections', async () => {
  const notes = await generateNotes(releaseNotesConfig, {
    cwd: process.cwd(),
    commits: [
      { message: 'feat: add dependency audit', hash: '1111111111111111111111111111111111111111' },
      { message: 'chore: refresh lockfile', hash: '2222222222222222222222222222222222222222' }
    ],
    lastRelease: {
      gitTag: 'v1.0.0',
      gitHead: '0000000000000000000000000000000000000000'
    },
    nextRelease: {
      version: '1.1.0',
      gitTag: 'v1.1.0',
      gitHead: '3333333333333333333333333333333333333333'
    },
    options: {
      repositoryUrl: 'https://github.com/agentconnect-md/agentconnect.git'
    }
  })

  assert.match(notes, /### Features/)
  assert.match(notes, /add dependency audit/)
  assert.match(notes, /### Internal/)
  assert.match(notes, /refresh lockfile/)
})

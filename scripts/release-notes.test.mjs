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

const fullChangelog = await import('./semantic-release-full-changelog.js')

function footer({ repositoryUrl, lastTag, nextTag = 'v1.1.0' }) {
  return fullChangelog.generateNotes(
    {},
    {
      lastRelease: lastTag ? { gitTag: lastTag } : {},
      nextRelease: { version: nextTag.slice(1), gitTag: nextTag },
      options: { repositoryUrl }
    }
  )
}

test('full changelog footer links the compare range between the two tags', () => {
  assert.equal(
    footer({ repositoryUrl: 'https://github.com/agentconnect-md/agentconnect.git', lastTag: 'v1.0.0' }),
    '**Full Changelog**: https://github.com/agentconnect-md/agentconnect/compare/v1.0.0...v1.1.0'
  )
})

test('full changelog footer drops remote userinfo and scp-like syntax', () => {
  const expected = '**Full Changelog**: https://github.com/agentconnect-md/agentconnect/compare/v1.0.0...v1.1.0'
  assert.equal(
    footer({ repositoryUrl: 'https://someone@github.com/agentconnect-md/agentconnect.git', lastTag: 'v1.0.0' }),
    expected
  )
  assert.equal(
    footer({ repositoryUrl: 'git@github.com:agentconnect-md/agentconnect.git', lastTag: 'v1.0.0' }),
    expected
  )
})

test("a channel's first release links the tag's commits instead of a compare range", () => {
  assert.equal(
    footer({ repositoryUrl: 'https://github.com/agentconnect-md/agentconnect.git' }),
    '**Full Changelog**: https://github.com/agentconnect-md/agentconnect/commits/v1.1.0'
  )
})

test('an unparseable repository url yields no footer rather than a broken link', () => {
  assert.equal(footer({ repositoryUrl: 'not a url', lastTag: 'v1.0.0' }), '')
  assert.equal(footer({ repositoryUrl: undefined, lastTag: 'v1.0.0' }), '')
})

test('the release config appends the footer plugin after the notes generator', () => {
  const generatorIndex = releaseConfig.plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === '@semantic-release/release-notes-generator'
  )
  const footerIndex = releaseConfig.plugins.indexOf('./scripts/semantic-release-full-changelog.js')
  assert.ok(footerIndex > generatorIndex)
})

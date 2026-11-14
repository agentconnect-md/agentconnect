'use strict'
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')

test('the VSIX carries the extension under the release version, and nothing from the tests', async (t) => {
  const { packageExtension } = await import('../scripts/package.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'agentconnect-vsix-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const vsix = packageExtension({ version: 'v3.4.5', output: join(directory, 'out.vsix') })
  const read = (path) => execFileSync('unzip', ['-p', vsix, path], { encoding: 'utf8' })
  const files = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()
  assert.deepEqual(
    files.filter((name) => !name.endsWith('/')),
    [
      '[Content_Types].xml',
      'extension.vsixmanifest',
      'extension/LICENSE.txt',
      'extension/extension.js',
      'extension/lib/ahp.js',
      'extension/lib/oauth.js',
      'extension/package.json',
      'extension/readme.md'
    ]
  )
  const manifest = JSON.parse(read('extension/package.json'))
  assert.equal(manifest.version, '3.4.5')
  assert.deepEqual(manifest.enabledApiProposals, ['authIssuers'])
  assert.match(read('extension.vsixmanifest'), /Id="agentconnect-vscode" Version="3\.4\.5" Publisher="agentconnect"/)
  assert.match(read('extension.vsixmanifest'), /Code\.EnabledApiProposals" Value="authIssuers"/)
})

test('a prerelease version is refused, since VS Code does not install one', async () => {
  const { packageExtension } = await import('../scripts/package.mjs')
  assert.throws(() => packageExtension({ version: 'v3.4.5-rc.1' }), /Not a major\.minor\.patch version/)
})

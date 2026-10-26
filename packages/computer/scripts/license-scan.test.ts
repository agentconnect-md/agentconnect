import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyExpression, forbiddenText, scanArtifacts } from './license-scan.js'

const scanner = fileURLToPath(new URL('./license-scan.ts', import.meta.url))
let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

// A package that bundles one dependency per license, laid out like a pnpm workspace member.
async function fixture(dependencies: Record<string, string>, entryExtra = '') {
  const root = mkdtempSync(join(tmpdir(), 'ac-license-scan-'))
  roots.push(root)
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write('package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'Apache-2.0' }))
  const imports = Object.keys(dependencies).map((name, index) => `import d${index} from '${name}'`)
  write(
    'src/main.js',
    `${imports.join('\n')}\n${entryExtra}\nconsole.log(${Object.keys(dependencies)
      .map((_, i) => `d${i}`)
      .join(', ')})\n`
  )
  for (const [name, license] of Object.entries(dependencies)) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', license, main: 'index.js' }))
    write(`node_modules/${name}/index.js`, `export default '${name}'\n`)
  }
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, 'src/main.js')],
    outfile: join(root, 'bundle/out.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    legalComments: 'linked',
    metafile: true,
    logLevel: 'silent'
  })
  write('bundle/.meta/out.mjs.json', JSON.stringify(result.metafile))
  return { root, artifacts: join(root, 'bundle'), options: { packageRoot: root, workspaceRoot: root } }
}

describe('license expressions', () => {
  it.each([
    ['MIT', 'allowed'],
    ['(MIT OR Apache-2.0)', 'allowed'],
    ['AGPL-3.0-only', 'forbidden'],
    ['GPL-2.0+', 'forbidden'],
    ['GPL-3.0-or-later WITH Classpath-exception-2.0', 'forbidden'],
    ['SSPL-1.0', 'forbidden'],
    ['BUSL-1.1', 'forbidden'],
    ['FSL-1.1-MIT', 'forbidden'],
    ['BSL-1.0', 'allowed'],
    ['MIT OR GPL-3.0-only', 'allowed'],
    ['MIT AND GPL-3.0-only', 'forbidden'],
    ['LGPL-3.0-only', 'unknown'],
    ['MPL-2.0', 'unknown'],
    ['SEE LICENSE IN LICENSE.md', 'unknown'],
    ['', 'unknown']
  ])('%s is %s', (expression, verdict) => {
    expect(classifyExpression(expression)).toBe(verdict)
  })

  it('finds forbidden licenses named in legal comments, but not the LGPL', () => {
    expect(forbiddenText('This program is free software: GNU Affero General Public License')).toContain('AGPL')
    expect(forbiddenText('/*! SPDX-License-Identifier: GPL-2.0-only */')).toContain('GPL-2.0-only')
    expect(forbiddenText('Licensed under the Business Source License 1.1')).toEqual(['BSL'])
    expect(forbiddenText('/*! AGPL-3.0 */')).toEqual(['AGPL'])
    expect(forbiddenText('GNU Lesser General Public License v2.1, see LGPL-2.1')).toEqual([])
    expect(forbiddenText('MIT License, Permission is hereby granted')).toEqual([])
  })
})

describe('scanArtifacts', () => {
  it('passes a bundle of permissive dependencies', async () => {
    const { artifacts, options } = await fixture({ 'ok-mit': 'MIT', 'ok-apache': 'Apache-2.0' })
    const result = scanArtifacts(artifacts, options)
    expect(result.violations).toEqual([])
    expect(result.components.map((component) => component.name)).toEqual([
      'fixture@1.0.0',
      'ok-apache@1.0.0',
      'ok-mit@1.0.0'
    ])
  })

  it('fails a seeded AGPL dependency, and the CLI exits non-zero', async () => {
    const { root, artifacts, options } = await fixture({ 'ok-mit': 'MIT', 'seeded-agpl': 'AGPL-3.0-only' })
    expect(scanArtifacts(artifacts, options).violations).toEqual([
      'seeded-agpl@1.0.0: forbidden license "AGPL-3.0-only" (out.mjs)'
    ])
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', scanner, artifacts, '--root', root, '--workspace', root],
      {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_STEP_SUMMARY: '' }
      }
    )
    expect(cli.status).toBe(1)
    expect(cli.stdout).toContain('seeded-agpl@1.0.0: forbidden license "AGPL-3.0-only"')
  })

  it('fails unknown licenses closed', async () => {
    const { artifacts, options } = await fixture({ 'odd-license': 'WTFPL' })
    expect(scanArtifacts(artifacts, options).violations).toEqual([
      'odd-license@1.0.0: license "WTFPL" is not on the allowlist (out.mjs)'
    ])
  })

  it('fails vendored code whose legal comment names the GPL', async () => {
    const { artifacts, options } = await fixture(
      { 'ok-mit': 'MIT' },
      '/*! Licensed under the GNU General Public License v3 */'
    )
    expect(scanArtifacts(artifacts, options).violations).toEqual([
      'out.mjs.LEGAL.txt: bundled legal comments name a forbidden license (GPL)'
    ])
  })

  it('fails ffmpeg, undeclared executables and archives in the artifacts', async () => {
    const { artifacts, options } = await fixture({ 'ok-mit': 'MIT' })
    writeFileSync(join(artifacts, 'ffmpeg'), 'x')
    writeFileSync(join(artifacts, 'helper'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]))
    chmodSync(join(artifacts, 'helper'), 0o755)
    writeFileSync(join(artifacts, 'extras.tar.gz'), 'x')
    expect(scanArtifacts(artifacts, options).violations.sort()).toEqual([
      'extras.tar.gz: undeclared archive; its contents cannot be scanned',
      'ffmpeg: ffmpeg and Cua Driver are separate downloads and must not ship in an artifact',
      'helper: undeclared executable; declare its component and license in license-scan.ts'
    ])
  })

  it('accepts the macOS app executable as the declared Node.js build', async () => {
    const { artifacts, options } = await fixture({ 'ok-mit': 'MIT' })
    const macos = join(artifacts, 'AgentConnect Computer.app', 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, 'agentconnect-computer'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))
    const result = scanArtifacts(artifacts, options)
    expect(result.violations).toEqual([])
    expect(result.components).toContainEqual(expect.objectContaining({ license: 'MIT', verdict: 'allowed' }))
  })

  it('fails when nothing was bundled to scan', () => {
    const empty = mkdtempSync(join(tmpdir(), 'ac-license-scan-'))
    roots.push(empty)
    expect(scanArtifacts(empty, { packageRoot: empty, workspaceRoot: empty }).violations[0]).toMatch(
      /no esbuild metafile/
    )
  })

  it('scans the macOS app package, which bundles no JavaScript, by its binaries alone', () => {
    const pkg = mkdtempSync(join(tmpdir(), 'ac-license-scan-'))
    roots.push(pkg)
    const macos = join(pkg, 'AgentConnect Computer.app', 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, 'agentconnect-computer'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))
    const options = { packageRoot: pkg, workspaceRoot: pkg, binariesOnly: true }
    expect(scanArtifacts(pkg, options)).toEqual({
      components: [expect.objectContaining({ license: 'MIT', verdict: 'allowed' })],
      violations: []
    })
    writeFileSync(join(macos, 'agentconnect-computer-menubar'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))
    expect(scanArtifacts(pkg, options)).toEqual({
      components: expect.arrayContaining([expect.objectContaining({ license: 'Apache-2.0', verdict: 'allowed' })]),
      violations: []
    })
    writeFileSync(join(macos, 'helper'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]))
    expect(scanArtifacts(pkg, options).violations).toEqual([
      'AgentConnect Computer.app/Contents/MacOS/helper: undeclared executable; declare its component and license in license-scan.ts'
    ])
  })
})

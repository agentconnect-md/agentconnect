import { afterEach, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveMicrosandboxImage } from '../src/release-image.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('requires an explicit image from source without using a package version as a guessed default', () => {
  expect(() => resolveMicrosandboxImage()).toThrow('without release image metadata')
  expect(resolveMicrosandboxImage('registry.example.test/sandbox@sha256:custom')).toBe(
    'registry.example.test/sandbox@sha256:custom'
  )
})

it('emits a release alias beside the packaged module, honors overrides, and clears it on a development rebuild', () => {
  const root = mkdtempSync(join(tmpdir(), 'ac-release-image-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'dist'))
  const emitter = join(root, 'scripts', 'prepare-release-image.mjs')
  copyFileSync(new URL('../scripts/prepare-release-image.mjs', import.meta.url), emitter)
  const entry = join(root, 'dist', 'index.mjs')
  writeFileSync(entry, stripTypeScriptTypes(readFileSync(new URL('../src/release-image.ts', import.meta.url), 'utf8')))
  const metadata = join(root, 'dist', 'release.json')
  const run = (explicit?: string) =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'const { resolveMicrosandboxImage } = await import(process.argv[1]); process.stdout.write(resolveMicrosandboxImage(process.argv[2]))',
        pathToFileURL(entry).href,
        ...(explicit === undefined ? [] : [explicit])
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  const emit = (version?: string) => {
    const env = { ...process.env }
    delete env.AGENTCONNECT_RELEASE_VERSION
    if (version !== undefined) env.AGENTCONNECT_RELEASE_VERSION = version
    execFileSync(process.execPath, [emitter], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  }

  for (const version of ['1.2.3', '1.2.4-rc.7']) {
    emit(version)
    expect(run()).toBe(`ghcr.io/agentconnect-md/runtime-sandbox-full:v${version}`)
  }
  writeFileSync(metadata, '{broken')
  expect(run('registry.example.test/custom:stable')).toBe('registry.example.test/custom:stable')
  expect(() => run()).toThrow('metadata could not be read')
  emit()
  expect(existsSync(metadata)).toBe(false)
  expect(() => run()).toThrow('without release image metadata')
})

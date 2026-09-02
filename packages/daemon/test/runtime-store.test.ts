import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RuntimeStore,
  installedRuntimeVersions,
  npmStoreEnv,
  parseNpxLaunch,
  runtimePackageTree,
  storedRuntimeDef,
  type NpmCommandRunner
} from '../src/runtimes/runtime-store.js'
import { runtimeStoreDir } from '../src/paths.js'
import { trustedRuntimeReadRoots } from '../src/runtimes/read-roots.js'
import { MANAGED_RUNTIME_CATALOG } from '../src/runtimes/managed.js'
import { CURATED_RUNTIME_CATALOG } from '../src/runtimes/curated.js'

const CODEX = MANAGED_RUNTIME_CATALOG['codex-acp']!.runtime

function root(): string {
  return mkdtempSync(join(tmpdir(), 'ac-store-'))
}

/** Write the tree npm would have produced, so the store finds a real bin to launch. */
function install(dir: string, name: string, bin: Record<string, string>): void {
  const packageDir = join(dir, 'node_modules', ...name.split('/'))
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, bin }))
  for (const relative of Object.values(bin)) {
    const path = join(packageDir, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '#!/usr/bin/env node\n')
  }
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {} }))
}

/** A runner that answers `npm view` with `version` and materializes what `npm install` would leave. */
function fakeNpm(
  version: string | undefined,
  name: string,
  bin: Record<string, string>,
  calls: string[][] = []
): { run: NpmCommandRunner; calls: string[][] } {
  const run: NpmCommandRunner = async (args, opts) => {
    calls.push(args)
    if (args[0] === 'view') {
      if (!version) throw new Error('ENOTFOUND registry.example.test')
      return `${JSON.stringify(version)}\n`
    }
    install(opts!.cwd!, name, bin)
    return ''
  }
  return { run, calls }
}

describe('parseNpxLaunch', () => {
  it('decomposes the managed codex-acp launch', () => {
    expect(parseNpxLaunch(CODEX)).toEqual({ name: '@agentconnect.md/codex-acp', range: 'agentconnect', args: [] })
  })

  it('keeps the bin an `npx -p <pkg> <bin>` launch names, and the arguments after it', () => {
    expect(parseNpxLaunch(CURATED_RUNTIME_CATALOG['dsh-acp']!.runtime)).toEqual({
      name: '@openma/deepseek-harness-acp',
      range: '^0.4',
      bin: 'dsh-acp',
      args: []
    })
    expect(parseNpxLaunch({ command: 'npx', args: ['-y', 'pkg', 'acp', '--flag'], env: [] })).toEqual({
      name: 'pkg',
      range: 'latest',
      args: ['acp', '--flag']
    })
  })

  it('leaves alone anything that is not a plain registry package launch', () => {
    expect(parseNpxLaunch({ command: 'codex', args: ['acp'], env: [] })).toBeUndefined()
    expect(parseNpxLaunch({ command: 'npx', args: ['-y', 'file:/tmp/evil.tgz'], env: [] })).toBeUndefined()
    expect(parseNpxLaunch({ command: 'npx', args: ['-y', 'https://evil.test/x.tgz'], env: [] })).toBeUndefined()
    expect(parseNpxLaunch({ command: 'npx', args: ['--call', 'pkg'], env: [] })).toBeUndefined()
  })
})

describe('RuntimeStore', () => {
  it('resolves the dist-tag once and never again, however many hosts ask', async () => {
    const dir = root()
    const { run, calls } = fakeNpm('1.4.2', '@agentconnect.md/codex-acp', { 'codex-acp': 'dist/index.js' })
    const store = new RuntimeStore({ root: dir, run })
    const launch = parseNpxLaunch(CODEX)!

    const [first, second] = await Promise.all([store.ensure(launch), store.ensure(launch)])
    const third = await store.ensure(launch)

    expect(first).toEqual(second)
    expect(third).toEqual(first)
    expect(calls.filter((args) => args[0] === 'view')).toHaveLength(1)
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(1)
    expect(first.version).toBe('1.4.2')
    expect(first.tree).toBe(runtimePackageTree(dir, '@agentconnect.md/codex-acp', '1.4.2'))
    expect(first.bin).toBe(join(first.tree, 'node_modules', '@agentconnect.md', 'codex-acp', 'dist', 'index.js'))
  })

  it('launches the installed bin with node, never through npx', async () => {
    const dir = root()
    const { run } = fakeNpm('1.4.2', '@agentconnect.md/codex-acp', { 'codex-acp': 'dist/index.js' })
    const launch = parseNpxLaunch(CODEX)!
    const installed = await new RuntimeStore({ root: dir, run }).ensure(launch)

    const def = storedRuntimeDef(CODEX, launch, installed)
    expect(def.command).toBe(process.execPath)
    expect(def.args).toEqual([installed.bin])
    expect([def.command, ...def.args].some((part) => part.includes('npx'))).toBe(false)
    expect(def.readRoots).toContain(installed.tree)
  })

  it('falls back to the newest install when the registry cannot be reached', async () => {
    const dir = root()
    const name = '@agentconnect.md/codex-acp'
    for (const version of ['1.4.2', '1.10.0', '1.10.0-rc.1']) {
      install(runtimePackageTree(dir, name, version), name, { 'codex-acp': 'dist/index.js' })
    }
    expect(installedRuntimeVersions(dir, name)).toEqual(['1.10.0', '1.10.0-rc.1', '1.4.2'])

    const { run, calls } = fakeNpm(undefined, name, { 'codex-acp': 'dist/index.js' })
    const installedPackage = await new RuntimeStore({ root: dir, run }).ensure(parseNpxLaunch(CODEX)!)
    expect(installedPackage.version).toBe('1.10.0')
    // Unresolved means the store never installs: it launches what it already holds, or nothing.
    expect(calls.filter((args) => args[0] === 'install')).toHaveLength(0)
  })

  it('refuses the launch and names the store when the registry is unreachable and nothing is installed', async () => {
    const dir = root()
    const { run } = fakeNpm(undefined, '@agentconnect.md/codex-acp', {})
    await expect(new RuntimeStore({ root: dir, run }).ensure(parseNpxLaunch(CODEX)!)).rejects.toThrow(
      runtimeStoreDir(dir)
    )
  })

  it('drops the versions it no longer launches once a new one is installed', async () => {
    const dir = root()
    const name = '@agentconnect.md/codex-acp'
    install(runtimePackageTree(dir, name, '1.0.0'), name, { 'codex-acp': 'dist/index.js' })
    const { run } = fakeNpm('1.4.2', name, { 'codex-acp': 'dist/index.js' })
    await new RuntimeStore({ root: dir, run }).ensure(parseNpxLaunch(CODEX)!)
    expect(installedRuntimeVersions(dir, name)).toEqual(['1.4.2'])
  })

  it('hands npm an allowlist, so no daemon secret is left for an .npmrc to interpolate', () => {
    expect(
      npmStoreEnv({
        PATH: '/bin',
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        HOME: '/var/lib/agentconnect',
        ANTHROPIC_API_KEY: 'sk-secret',
        GITHUB_TOKEN: 'ghp_secret'
      })
    ).toEqual({ PATH: '/bin', HTTPS_PROXY: 'http://proxy.example.test:3128', HOME: '/var/lib/agentconnect' })
  })
})

describe('sandbox read roots', () => {
  it('carves the store tree back, so the denied daemon root still exposes the adapter', async () => {
    const dir = root()
    const { run } = fakeNpm('1.4.2', '@agentconnect.md/codex-acp', { 'codex-acp': 'dist/index.js' })
    const launch = parseNpxLaunch(CODEX)!
    const installed = await new RuntimeStore({ root: dir, run }).ensure(launch)

    const roots = trustedRuntimeReadRoots({ runtime: storedRuntimeDef(CODEX, launch, installed) })
    expect(roots).toContain(realpathSync(installed.tree))
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SandboxMount } from '../src/config/config-schema.js'
import {
  resolveTrustedExecutable,
  normalizeSandboxMounts,
  trustedRuntimeReadRoots
} from '../src/runtimes/read-roots.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('trusted runtime read roots', () => {
  // The trusted executable is an extensionless symlink at mode 0755, which Windows PATH resolution does not accept.
  it.skipIf(process.platform === 'win32')('collapses a package installation to a small code-store policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-runtime-roots-'))
    temporaryRoots.push(root)
    const bin = join(root, 'home', 'bin')
    const store = join(root, 'home', 'store', 'node_modules', '.pnpm')
    const pkg = join(store, 'runtime@1.0.0', 'node_modules', 'runtime')
    const cli = join(pkg, 'cli.js')
    const extra = join(root, 'home', 'runtime-data-free-code')
    mkdirSync(bin, { recursive: true })
    mkdirSync(pkg, { recursive: true })
    mkdirSync(extra)
    writeFileSync(join(pkg, 'package.json'), '{"name":"runtime","version":"1.0.0"}')
    writeFileSync(cli, '#!/usr/bin/env node\n')
    chmodSync(cli, 0o755)
    symlinkSync(cli, join(bin, 'runtime'))

    const roots = trustedRuntimeReadRoots({
      runtime: { command: 'runtime', args: [], env: [], readRoots: [extra] },
      hostEnv: { PATH: `${bin}:${dirname(process.execPath)}`, HOME: join(root, 'host') }
    })

    expect(roots).toContain(bin)
    expect(roots).toContain(realpathSync(store))
    expect(roots).toContain(realpathSync(extra))
    expect(roots.some((path) => path.includes('runtime@1.0.0'))).toBe(false)
    expect(roots.length).toBeLessThanOrEqual(5)
    expect(resolveTrustedExecutable('runtime', { PATH: bin })).toBe(realpathSync(cli))
  })

  it('exposes normalized operator mount sources to every runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-roots-'))
    temporaryRoots.push(root)
    const home = join(root, 'host-home')
    const toolchain = join(home, '.rustup', 'toolchains', 'stable', 'bin')
    const nodeInstall = join(root, 'opt', 'node-24')
    mkdirSync(toolchain, { recursive: true })
    mkdirSync(nodeInstall, { recursive: true })

    const mounts = normalizeSandboxMounts(
      [
        { source: '~/.rustup/toolchains/stable/bin', target: toolchain, mode: 'readonly' },
        { source: nodeInstall, target: nodeInstall, mode: 'readonly' }
      ],
      { HOME: home }
    )
    const roots = trustedRuntimeReadRoots({
      runtime: { command: process.execPath, args: [], env: [] },
      hostEnv: { PATH: dirname(process.execPath), HOME: home },
      readRoots: mounts.map((mount) => mount.source)
    })

    expect(roots).toContain(realpathSync(toolchain))
    expect(roots).toContain(realpathSync(nodeInstall))
  })

  it('rejects a daemon-wide read root that does not exist', () => {
    expect(() =>
      trustedRuntimeReadRoots({
        runtime: { command: process.execPath, args: [], env: [] },
        hostEnv: { PATH: dirname(process.execPath) },
        readRoots: [join(tmpdir(), 'ac-missing-daemon-root-does-not-exist')]
      })
    ).toThrow(/sandbox\.mounts source does not exist/)
  })

  it('coalesces canonical mounts with write access winning while preserving nested paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-write-roots-'))
    temporaryRoots.push(root)
    const home = join(root, 'host-home')
    const toolchain = join(home, 'toolchain')
    const store = join(toolchain, 'cache')
    const alias = join(root, 'cache-link')
    mkdirSync(store, { recursive: true })
    symlinkSync(store, alias, 'junction')

    const mounts: SandboxMount[] = [
      { source: '~/toolchain', target: toolchain, mode: 'readonly' },
      { source: alias, target: store, mode: 'readonly' },
      { source: store, target: alias, mode: 'writable' }
    ]
    const expected = [
      { source: realpathSync(toolchain), target: realpathSync(toolchain), mode: 'readonly' },
      { source: realpathSync(store), target: realpathSync(store), mode: 'writable' }
    ]
    for (const entries of [mounts, [...mounts].reverse()]) {
      const normalized = normalizeSandboxMounts(entries, { HOME: home })
      expect(normalized).toHaveLength(2)
      expect(normalized).toEqual(expect.arrayContaining(expected))
    }
  })

  it('accepts an existing file mount and rejects missing, relative, or remapped paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-mount-paths-'))
    temporaryRoots.push(root)
    const file = join(root, 'toolchain.conf')
    writeFileSync(file, 'test configuration')
    const mount: SandboxMount = { source: file, target: file, mode: 'readonly' }
    expect(normalizeSandboxMounts([mount])).toEqual([
      { source: realpathSync(file), target: realpathSync(file), mode: 'readonly' }
    ])
    expect(() => normalizeSandboxMounts([{ ...mount, source: join(root, 'missing') }])).toThrow(
      /sandbox\.mounts source does not exist/
    )
    expect(() => normalizeSandboxMounts([{ ...mount, source: 'relative/toolchain' }])).toThrow(
      /sandbox\.mounts source must be absolute/
    )
    expect(() => normalizeSandboxMounts([{ ...mount, target: 'relative/toolchain' }])).toThrow(
      /sandbox\.mounts target must be absolute/
    )
    expect(() => normalizeSandboxMounts([{ ...mount, target: root }])).toThrow(/same|equal|remap/i)
  })

  it('maps canonical microsandbox sources to guest paths without resolving those paths on the host', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-vm-mounts-'))
    temporaryRoots.push(root)
    const store = join(root, 'store')
    const nested = join(store, 'nested')
    const alias = join(root, 'store-link')
    mkdirSync(nested, { recursive: true })
    symlinkSync(store, alias, 'junction')
    const mounts: SandboxMount[] = [
      { source: '~/store-link', target: '/cache/../cache/store/', mode: 'readonly' },
      { source: store, target: '/cache/store', mode: 'writable' },
      { source: nested, target: '/cache/store/nested', mode: 'readonly' },
      { source: store, target: '/other-cache', mode: 'readonly' }
    ]
    const expected = [
      { source: realpathSync(store), target: '/cache/store', mode: 'writable' },
      { source: realpathSync(nested), target: '/cache/store/nested', mode: 'readonly' },
      { source: realpathSync(store), target: '/other-cache', mode: 'readonly' }
    ]
    for (const entries of [mounts, [...mounts].reverse()]) {
      const normalized = normalizeSandboxMounts(entries, { HOME: root }, 'microsandbox')
      expect(normalized).toHaveLength(expected.length)
      expect(normalized).toEqual(expect.arrayContaining(expected))
    }
    expect(() =>
      normalizeSandboxMounts(
        [...mounts, { source: nested, target: '/cache/store/', mode: 'writable' }],
        { HOME: root },
        'microsandbox'
      )
    ).toThrow(/different sources to the same target/)
  })

  it('accepts microsandbox file mounts and rejects invalid source or guest paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-vm-mount-paths-'))
    temporaryRoots.push(root)
    const file = join(root, 'config')
    writeFileSync(file, 'configuration')
    const normalize = (source: string, target = '/cache') =>
      normalizeSandboxMounts([{ source, target, mode: 'readonly' }], {}, 'microsandbox')
    expect(() => normalize(join(root, 'missing'))).toThrow(/source does not exist/)
    expect(() => normalize('relative/source')).toThrow(/source must be absolute/)
    expect(normalize(file)).toEqual([{ source: realpathSync(file), target: '/cache', mode: 'readonly' }])
    for (const target of ['relative/target', '~/../cache', 'C:\\cache', '/cache\0invalid']) {
      expect(() => normalize(root, target)).toThrow(/absolute POSIX guest path/)
    }
    for (const target of ['/', '//', '/cache/..']) {
      expect(() => normalize(root, target)).toThrow(/must not be the guest root/)
    }
  })

  it('resolves guest HOME at launch and limits overlays to independent directory mounts in microsandbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-overlay-mounts-'))
    temporaryRoots.push(root)
    const mount: SandboxMount = { source: root, target: '~/.cache/store', mode: 'overlay' }
    const normalized = normalizeSandboxMounts([mount], {}, 'microsandbox')
    expect(normalized[0]!.target).toBe('~/.cache/store')
    expect(normalizeSandboxMounts(normalized, {}, 'microsandbox', '/session/home')[0]!.target).toBe(
      '/session/home/.cache/store'
    )
    expect(() => normalizeSandboxMounts([{ ...mount, target: root }])).toThrow('requires microsandbox')
    const file = join(root, 'file')
    writeFileSync(file, '')
    expect(() => normalizeSandboxMounts([{ ...mount, source: file }], {}, 'microsandbox')).toThrow(
      'overlay source must be a directory'
    )
    for (const target of [mount.target, `${mount.target}/child`, '~/.cache']) {
      expect(() => normalizeSandboxMounts([mount, { ...mount, target, mode: 'writable' }], {}, 'microsandbox')).toThrow(
        /cannot combine|must not overlap/
      )
    }
  })

  it('rejects relative operator read roots', () => {
    expect(() =>
      trustedRuntimeReadRoots({
        runtime: { command: process.execPath, args: [], env: [], readRoots: ['relative/code'] },
        hostEnv: { PATH: dirname(process.execPath) }
      })
    ).toThrow(/must be absolute/)
  })
})

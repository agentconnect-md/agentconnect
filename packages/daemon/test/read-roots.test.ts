import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  resolveTrustedExecutable,
  sandboxReadRoots,
  sandboxWriteRoots,
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

  it('carves daemon-wide security.sandboxReadRoots into every runtime, expanding ~ against the host HOME', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-roots-'))
    temporaryRoots.push(root)
    const home = join(root, 'host-home')
    const toolchain = join(home, '.rustup', 'toolchains', 'stable', 'bin')
    const nodeInstall = join(root, 'opt', 'node-24')
    mkdirSync(toolchain, { recursive: true })
    mkdirSync(nodeInstall, { recursive: true })

    const roots = trustedRuntimeReadRoots({
      runtime: { command: process.execPath, args: [], env: [] },
      hostEnv: { PATH: dirname(process.execPath), HOME: home },
      readRoots: ['~/.rustup/toolchains/stable/bin', nodeInstall]
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
    ).toThrow(/security\.sandboxReadRoots entry does not exist/)
    expect(() => sandboxReadRoots(['relative/toolchain'], { HOME: tmpdir() })).toThrow(
      /security\.sandboxReadRoots entry must be absolute/
    )
  })

  it('normalizes security.sandboxWriteRoots like the read roots, and rejects a missing or relative one', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-daemon-write-roots-'))
    temporaryRoots.push(root)
    const home = join(root, 'host-home')
    const store = join(home, '.local', 'share', 'pnpm', 'store')
    mkdirSync(store, { recursive: true })

    expect(sandboxWriteRoots(['~/.local/share/pnpm/store'], { HOME: home })).toEqual([realpathSync(store)])
    expect(() => sandboxWriteRoots([join(root, 'no-such-store')], { HOME: home })).toThrow(
      /security\.sandboxWriteRoots entry does not exist/
    )
    expect(() => sandboxWriteRoots(['relative/store'], { HOME: home })).toThrow(
      /security\.sandboxWriteRoots entry must be absolute/
    )
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

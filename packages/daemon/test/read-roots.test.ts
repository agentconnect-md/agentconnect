import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveTrustedExecutable, trustedRuntimeReadRoots } from '../src/runtimes/read-roots.js'

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

  it('rejects relative operator read roots', () => {
    expect(() =>
      trustedRuntimeReadRoots({
        runtime: { command: process.execPath, args: [], env: [], readRoots: ['relative/code'] },
        hostEnv: { PATH: dirname(process.execPath) }
      })
    ).toThrow(/must be absolute/)
  })
})

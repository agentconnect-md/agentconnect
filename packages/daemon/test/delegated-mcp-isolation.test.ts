import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  delegatedMcpInCellSocketDirectory,
  delegatedCellSandboxWrap,
  detectSandbox,
  sandboxWrap,
  SandboxError,
  supportsDelegatedMcpIsolation
} from '../src/acp/sandbox.js'

const privateHomeRoots: string[] = []
const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
const PRIVATE_TARGET_DIRECTORY = delegatedMcpInCellSocketDirectory()
const CANONICAL_PRIVATE_TARGET_DIRECTORY = join(realpathSync(tmpdir()), 'agentconnect-admin')
const runBwrapE2e = process.platform === 'linux' && process.env.AGENTCONNECT_RUN_BWRAP_E2E === '1'
afterEach(() => {
  for (const root of privateHomeRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function privateHomeMount() {
  const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-private-homes-'))
  const canonicalRoot = realpathSync(maskedRoot)
  expect(canonicalRoot).not.toBe(repoRoot)
  expect(canonicalRoot.startsWith(repoRoot + sep)).toBe(false)
  privateHomeRoots.push(maskedRoot)
  const sourceDir = join(maskedRoot, 'cell-home')
  mkdirSync(sourceDir)
  return { maskedRoot, sourceDir, targetDir: sourceDir }
}

describe('supportsDelegatedMcpIsolation', () => {
  it.each([
    {
      name: 'macOS sandbox-exec',
      platform: 'darwin' as const,
      mechanism: 'sandbox-exec' as const,
      requireSandbox: true,
      bwrapProbePassed: true
    },
    {
      name: 'missing bwrap',
      platform: 'linux' as const,
      mechanism: undefined,
      requireSandbox: true,
      bwrapProbePassed: true
    },
    {
      name: 'failed bwrap probe',
      platform: 'linux' as const,
      mechanism: 'bwrap' as const,
      requireSandbox: true,
      bwrapProbePassed: false
    },
    {
      name: 'optional sandbox',
      platform: 'linux' as const,
      mechanism: 'bwrap' as const,
      requireSandbox: false,
      bwrapProbePassed: true
    }
  ])('rejects $name', ({ name: _name, ...input }) => {
    expect(supportsDelegatedMcpIsolation(input)).toBe(false)
  })

  it('accepts only enforced Linux bwrap after a successful probe', () => {
    expect(
      supportsDelegatedMcpIsolation({
        platform: 'linux',
        mechanism: 'bwrap',
        requireSandbox: true,
        bwrapProbePassed: true
      })
    ).toBe(true)
  })
})

describe('delegated bwrap mount isolation', () => {
  it('masks the common source root for an ordinary host without binding anything back', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const canonicalMaskedRoot = realpathSync(maskedRoot)

    const { cmd, args } = sandboxWrap('codex', ['--acp'], {
      mechanism: 'bwrap',
      writable: [],
      maskedReadRoots: [maskedRoot]
    })

    expect(cmd).toBe('bwrap')
    expect(args).toContain('--unshare-pid')
    expect(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])
    expect(args.slice(args.indexOf(canonicalMaskedRoot) - 1, args.indexOf(canonicalMaskedRoot) + 1)).toEqual([
      '--tmpfs',
      canonicalMaskedRoot
    ])
    expect(args).not.toContain('--bind')
  })

  it('binds back exactly the entitled broker cell and runtime HOME after masking both private roots', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = join(maskedRoot, 'cell-a')
    const targetDir = PRIVATE_TARGET_DIRECTORY
    const baseWritable = mkdtempSync(join(tmpdir(), 'ac-agent-workspace-'))
    mkdirSync(sourceDir)
    const canonicalMaskedRoot = realpathSync(maskedRoot)
    const canonicalSourceDir = realpathSync(sourceDir)
    const canonicalTargetDir = CANONICAL_PRIVATE_TARGET_DIRECTORY
    const canonicalBaseWritable = realpathSync(baseWritable)

    const homeMount = privateHomeMount()
    const { cmd, args } = delegatedCellSandboxWrap(
      'codex',
      ['--acp'],
      [baseWritable],
      {
        maskedRoot,
        sourceDir,
        targetDir
      },
      homeMount
    )

    expect(cmd).toBe('bwrap')
    expect(args).toContain('--unshare-pid')
    expect(args.slice(args.indexOf('--proc'), args.indexOf('--proc') + 2)).toEqual(['--proc', '/proc'])

    const maskIndex = args.indexOf(canonicalMaskedRoot)
    const canonicalHomeRoot = realpathSync(homeMount.maskedRoot)
    const canonicalHome = realpathSync(homeMount.sourceDir)
    const homeMaskIndex = args.indexOf(canonicalHomeRoot)
    const bindIndexes = args.flatMap((arg, index) => (arg === '--bind' ? [index] : []))
    const targetCreationIndex = args.indexOf(canonicalTargetDir)
    expect(args[maskIndex - 1]).toBe('--tmpfs')
    expect(args[homeMaskIndex - 1]).toBe('--tmpfs')
    expect(args[targetCreationIndex - 1]).toBe('--dir')
    expect(targetCreationIndex).toBeGreaterThan(maskIndex)
    expect(
      bindIndexes.map((index) => args.slice(index, index + 3)).filter(([, source]) => source === canonicalSourceDir)
    ).toEqual([['--bind', canonicalSourceDir, canonicalTargetDir]])
    expect(
      bindIndexes.map((index) => args.slice(index, index + 3)).filter(([, source]) => source === canonicalHome)
    ).toEqual([['--bind', canonicalHome, canonicalHome]])
    expect(args.slice(bindIndexes[0], bindIndexes[0]! + 3)).toEqual([
      '--bind',
      canonicalBaseWritable,
      canonicalBaseWritable
    ])
    expect(bindIndexes.at(-1)).toBeGreaterThan(homeMaskIndex)
  })

  it('creates the designated endpoint inside bwrap private tmp without overlaying a broad host directory', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = join(maskedRoot, 'cell-a')
    mkdirSync(sourceDir)
    const homeMount = privateHomeMount()

    const { args } = delegatedCellSandboxWrap(
      'codex',
      ['--acp'],
      [],
      {
        maskedRoot,
        sourceDir,
        targetDir: PRIVATE_TARGET_DIRECTORY
      },
      homeMount
    )

    const targetCreation = args.findIndex(
      (arg, index) => arg === CANONICAL_PRIVATE_TARGET_DIRECTORY && args[index - 1] === '--dir'
    )
    const entitledBind = args.findIndex(
      (arg, index) =>
        arg === realpathSync(sourceDir) &&
        args[index - 1] === '--bind' &&
        args[index + 1] === CANONICAL_PRIVATE_TARGET_DIRECTORY
    )
    expect(args.filter((arg, index) => arg === tmpdir() && args[index - 1] === '--tmpfs')).toHaveLength(1)
    expect(args).not.toContain('/run/agentconnect-admin')
    expect(targetCreation).toBeGreaterThan(args.indexOf(realpathSync(maskedRoot)))
    expect(entitledBind).toBeGreaterThan(targetCreation)
    expect(
      args.filter((arg, index) => arg === CANONICAL_PRIVATE_TARGET_DIRECTORY && args[index - 2] === '--bind')
    ).toHaveLength(1)
  })

  it.each(['/run/agentconnect-admin', join(tmpdir(), 'nested', 'agentconnect-admin'), tmpdir()])(
    'rejects non-designated delegated target %s',
    (targetDir) => {
      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceDir = join(maskedRoot, 'cell-a')
      mkdirSync(sourceDir)

      expect(() =>
        delegatedCellSandboxWrap('codex', ['--acp'], [], { maskedRoot, sourceDir, targetDir }, privateHomeMount())
      ).toThrow(new SandboxError('invalid delegated cell mount'))
    }
  )

  it('imports and builds a general sandbox but fails delegated launch closed for a missing temp root', async () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = join(maskedRoot, 'cell-a')
    mkdirSync(sourceDir)
    const homeMount = privateHomeMount()
    const missingTmp = join(maskedRoot, 'missing-tmp')
    const previous = {
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMP,
      TEMP: process.env.TEMP
    }

    try {
      process.env.TMPDIR = missingTmp
      process.env.TMP = missingTmp
      process.env.TEMP = missingTmp

      vi.resetModules()
      const sandbox = await import('../src/acp/sandbox.js')
      expect(() =>
        sandbox.sandboxWrap('codex', ['--acp'], {
          mechanism: 'bwrap',
          writable: [],
          maskedReadRoots: []
        })
      ).not.toThrow()
      expect(() =>
        sandbox.delegatedCellSandboxWrap(
          'codex',
          ['--acp'],
          [],
          {
            maskedRoot,
            sourceDir,
            targetDir: sandbox.delegatedMcpInCellSocketDirectory()
          },
          homeMount
        )
      ).toThrow(new SandboxError('invalid delegated cell mount'))
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('rejects a mount source outside the masked root', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = mkdtempSync(join(tmpdir(), 'ac-outside-cell-'))

    expect(() => {
      delegatedCellSandboxWrap(
        'codex',
        ['--acp'],
        [],
        {
          maskedRoot,
          sourceDir,
          targetDir: PRIVATE_TARGET_DIRECTORY
        },
        privateHomeMount()
      )
    }).toThrow(new SandboxError('invalid delegated cell mount'))
  })

  it('rejects a mount source whose symlink escapes the masked root', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const maskedRoot = join(root, 'broker')
    const outside = join(root, 'outside')
    mkdirSync(maskedRoot)
    mkdirSync(outside)
    symlinkSync(outside, join(maskedRoot, 'cell-a'))

    expect(() => {
      delegatedCellSandboxWrap(
        'codex',
        ['--acp'],
        [],
        {
          maskedRoot,
          sourceDir: join(maskedRoot, 'cell-a'),
          targetDir: PRIVATE_TARGET_DIRECTORY
        },
        privateHomeMount()
      )
    }).toThrow(new SandboxError('invalid delegated cell mount'))
  })

  it.each(['masked root', 'source directory'] as const)(
    'rejects a missing %s without disclosing its path',
    (missing) => {
      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceDir = join(maskedRoot, 'cell-a')
      mkdirSync(sourceDir)
      const missingPath = join(maskedRoot, 'private-daemon-path-do-not-leak')

      expect(() => {
        delegatedCellSandboxWrap(
          'codex',
          ['--acp'],
          [],
          {
            maskedRoot: missing === 'masked root' ? missingPath : maskedRoot,
            sourceDir: missing === 'source directory' ? missingPath : sourceDir,
            targetDir: PRIVATE_TARGET_DIRECTORY
          },
          privateHomeMount()
        )
      }).toThrow(new SandboxError('invalid delegated cell mount'))
    }
  )

  it.each(['masked root', 'source directory'] as const)(
    'rejects a non-directory %s without disclosing its path',
    (nonDirectory) => {
      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceDir = join(maskedRoot, 'cell-a')
      const filePath = join(maskedRoot, 'private-daemon-file-do-not-leak')
      mkdirSync(sourceDir)
      writeFileSync(filePath, 'not a directory')

      expect(() => {
        delegatedCellSandboxWrap(
          'codex',
          ['--acp'],
          [],
          {
            maskedRoot: nonDirectory === 'masked root' ? filePath : maskedRoot,
            sourceDir: nonDirectory === 'source directory' ? filePath : sourceDir,
            targetDir: PRIVATE_TARGET_DIRECTORY
          },
          privateHomeMount()
        )
      }).toThrow(new SandboxError('invalid delegated cell mount'))
    }
  )

  it('rejects a symlink loop without disclosing its path', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const loopPath = join(maskedRoot, 'private-daemon-loop-do-not-leak')
    symlinkSync(loopPath, loopPath)

    expect(() => {
      delegatedCellSandboxWrap(
        'codex',
        ['--acp'],
        [],
        {
          maskedRoot,
          sourceDir: loopPath,
          targetDir: PRIVATE_TARGET_DIRECTORY
        },
        privateHomeMount()
      )
    }).toThrow(new SandboxError('invalid delegated cell mount'))
  })

  it('rejects an inaccessible source directory without disclosing its path', () => {
    const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
    const sourceDir = join(maskedRoot, 'private-daemon-source-do-not-leak')
    mkdirSync(sourceDir)
    chmodSync(maskedRoot, 0o000)

    try {
      expect(() => {
        delegatedCellSandboxWrap(
          'codex',
          ['--acp'],
          [],
          {
            maskedRoot,
            sourceDir,
            targetDir: PRIVATE_TARGET_DIRECTORY
          },
          privateHomeMount()
        )
      }).toThrow(new SandboxError('invalid delegated cell mount'))
    } finally {
      chmodSync(maskedRoot, 0o700)
    }
  })
})

describe('bwrap delegated mount behavior', () => {
  it.skipIf(!runBwrapE2e)(
    'masks every source from ordinary hosts and reveals only the entitled cell at its target',
    () => {
      expect(detectSandbox(), 'dedicated Linux isolation CI must provide a working bwrap').toBe('bwrap')

      const maskedRoot = mkdtempSync(join(tmpdir(), 'ac-admin-sockets-'))
      const sourceA = join(maskedRoot, 'cell-a')
      const sourceB = join(maskedRoot, 'cell-b')
      const targetA = PRIVATE_TARGET_DIRECTORY
      mkdirSync(sourceA)
      mkdirSync(sourceB)
      writeFileSync(join(sourceA, 'marker'), 'alpha')
      writeFileSync(join(sourceB, 'marker'), 'bravo')
      const canonicalMaskedRoot = realpathSync(maskedRoot)
      const canonicalTargetA = CANONICAL_PRIVATE_TARGET_DIRECTORY

      const ordinary = sandboxWrap(
        'sh',
        ['-c', 'test ! -e "$1/cell-a/marker" && test ! -e "$1/cell-b/marker"', 'sh', canonicalMaskedRoot],
        {
          mechanism: 'bwrap',
          writable: [],
          maskedReadRoots: [maskedRoot]
        }
      )
      execFileSync(ordinary.cmd, ordinary.args)

      const entitled = delegatedCellSandboxWrap(
        'sh',
        [
          '-c',
          'test "$(cat "$1/marker")" = alpha && test ! -e "$2/cell-a/marker" && test ! -e "$2/cell-b/marker"',
          'sh',
          canonicalTargetA,
          canonicalMaskedRoot
        ],
        [],
        {
          maskedRoot,
          sourceDir: sourceA,
          targetDir: targetA
        },
        privateHomeMount()
      )
      execFileSync(entitled.cmd, entitled.args)
    }
  )
})

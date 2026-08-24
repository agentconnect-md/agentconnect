import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PINNED_SKILLS_CLI_VERSION,
  resolvePinnedSkillsCli,
  scanSkillsCliCell,
  SkillsCliCellError,
  stageSkillsCliCell,
  type ResolvedSkillsCli,
  type SkillsCliRunOptions
} from '../src/skills/skills-cli-cell.js'

describe('resolvePinnedSkillsCli', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-cli-package-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function packageResolver(version = PINNED_SKILLS_CLI_VERSION): (specifier: string) => string {
    const manifest = join(root, 'node_modules', 'skills', 'package.json')
    const bin = join(dirname(manifest), 'bin', 'cli.mjs')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(manifest, JSON.stringify({ version, bin: { skills: 'bin/cli.mjs' } }))
    writeFileSync(bin, '#!/usr/bin/env node\n')
    return (specifier) => {
      expect(specifier).toBe('skills/package.json')
      return manifest
    }
  }

  it('resolves the package bin only at the audited exact version', () => {
    const resolved = resolvePinnedSkillsCli(packageResolver())
    expect(resolved).toEqual({
      version: '1.5.21',
      binPath: realpathSync(join(root, 'node_modules', 'skills', 'bin', 'cli.mjs')),
      readRoots: [realpathSync(join(root, 'node_modules')), realpathSync(join(root, 'node_modules', 'skills'))]
    })
  })

  it('fails closed when dependency resolution returns another version', () => {
    expect(() => resolvePinnedSkillsCli(packageResolver('1.5.22'))).toThrow(/version mismatch.*1\.5\.21.*1\.5\.22/)
  })
})

describe('stageSkillsCliCell', () => {
  let root: string
  let snapshot: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'skills-cli-cell-test-'))
    snapshot = join(root, 'snapshot')
    mkdirSync(snapshot)
    snapshot = realpathSync(snapshot)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('runs the exact bin and argv in an isolated private environment, then returns CLI-derived bundles', async () => {
    let captured:
      | {
          executable: string
          args: string[]
          options: SkillsCliRunOptions
        }
      | undefined
    const result = await stageSkillsCliCell({
      sourceSnapshot: snapshot,
      agentId: 'future-agent',
      selectedSkills: ['alpha', 'beta'],
      tempParent: root,
      hostEnv: {
        PATH: '/trusted/bin',
        SECRET_TOKEN: 'do-not-inherit',
        HTTPS_PROXY: 'http://proxy.invalid',
        NODE_OPTIONS: '--require=evil',
        GIT_CONFIG_0: 'credential.helper=evil',
        NPM_TOKEN: 'do-not-inherit',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
        LD_PRELOAD: '/tmp/evil.so'
      },
      resolveCli: () => ({ version: PINNED_SKILLS_CLI_VERSION, binPath: '/package/bin/cli.mjs' }),
      runner: async (executable, args, options) => {
        captured = { executable, args, options }
        const bundle = join(options.cwd, '.future-runtime', 'skills', 'alpha')
        mkdirSync(join(bundle, 'nested'), { recursive: true })
        writeFileSync(join(bundle, 'SKILL.md'), '---\nname: alpha\ndescription: test\n---\n')
        writeFileSync(join(bundle, 'nested', 'tool.txt'), 'tool')
        writeFileSync(join(options.cwd, 'skills-lock.json'), '{}\n')
        return { exitCode: 0, stdout: 'Installed alpha', stderr: '' }
      }
    })

    expect(captured?.executable).toBe(process.execPath)
    expect(captured?.args).toEqual([
      '/package/bin/cli.mjs',
      'add',
      snapshot,
      '-a',
      'future-agent',
      '-y',
      '--copy',
      '-s',
      'alpha',
      '-s',
      'beta'
    ])
    expect(captured?.options.cwd).toBe(result.cwd)
    expect(captured?.options.timeoutMs).toBe(20_000)
    expect(captured?.options.maxOutputBytes).toBe(512 * 1024)
    expect(captured?.options.env).toMatchObject({
      PATH: '/trusted/bin',
      CI: '1',
      DO_NOT_TRACK: '1',
      DISABLE_TELEMETRY: '1',
      GIT_TERMINAL_PROMPT: '0'
    })
    for (const forbidden of [
      'SECRET_TOKEN',
      'HTTPS_PROXY',
      'NODE_OPTIONS',
      'GIT_CONFIG_0',
      'NPM_TOKEN',
      'SSH_AUTH_SOCK',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD'
    ]) {
      expect(captured?.options.env).not.toHaveProperty(forbidden)
    }
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
      'XDG_RUNTIME_DIR',
      'TMPDIR',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR'
    ]) {
      const path = captured?.options.env[key]
      expect(path).toEqual(expect.stringContaining(result.cellRoot))
      expect(lstatSync(path!).mode & 0o777).toBe(0o700)
    }
    expect(lstatSync(result.cellRoot).mode & 0o777).toBe(0o700)
    expect(lstatSync(result.cwd).mode & 0o777).toBe(0o700)
    expect(result.bundles).toEqual([
      expect.objectContaining({
        relativePath: '.future-runtime/skills/alpha',
        root: '.future-runtime',
        name: 'alpha',
        fileCount: 2
      })
    ])
    expect(readFileSync(result.lockFile!, 'utf8')).toBe('{}\n')

    const cellRoot = result.cellRoot
    result.cleanup()
    result.cleanup()
    expect(existsSync(cellRoot)).toBe(false)
  })

  it('rejects an exit-zero textual failure and cleans the cell', async () => {
    let cellRoot: string | undefined
    await expect(
      stageSkillsCliCell({
        sourceSnapshot: snapshot,
        agentId: 'codex',
        tempParent: root,
        resolveCli: () => ({ version: PINNED_SKILLS_CLI_VERSION, binPath: '/package/bin/cli.mjs' }),
        runner: async (_executable, _args, options) => {
          cellRoot = dirname(options.cwd)
          return { exitCode: 0, stdout: '\u001b[31mFailed to install\u001b[0m skill', stderr: '' }
        }
      })
    ).rejects.toThrow('skills CLI reported an install failure')
    expect(existsSync(cellRoot!)).toBe(false)
  })

  it('enforces returned-output bounds even for an injected runner', async () => {
    await expect(
      stageSkillsCliCell({
        sourceSnapshot: snapshot,
        agentId: 'codex',
        tempParent: root,
        maxOutputBytes: 4,
        resolveCli: () => ({ version: PINNED_SKILLS_CLI_VERSION, binPath: '/package/bin/cli.mjs' }),
        runner: async () => ({ exitCode: 0, stdout: '12345', stderr: '' })
      })
    ).rejects.toThrow('output exceeded its limit')
  })

  it('requires an absolute source snapshot and safe option values', async () => {
    const base = {
      agentId: 'codex',
      resolveCli: (): ResolvedSkillsCli => ({ version: PINNED_SKILLS_CLI_VERSION, binPath: '/package/bin/cli.mjs' }),
      runner: async () => ({ exitCode: 0, stdout: '', stderr: '' })
    }
    await expect(stageSkillsCliCell({ ...base, sourceSnapshot: 'relative' })).rejects.toThrow(/must be absolute/)
    await expect(
      stageSkillsCliCell({ ...base, sourceSnapshot: snapshot, selectedSkills: ['--agent', 'safe'] })
    ).rejects.toThrow(/invalid selected skill/)
    // Selections are resolved frontmatter names (skill-cli-selection.ts), not
    // canonical leaves — only option-shaped or argv-unsafe values are refused.
    for (const selectedSkill of ['-s', '', 'a\nb', '烧烤', `x${'y'.repeat(256)}`]) {
      await expect(
        stageSkillsCliCell({ ...base, sourceSnapshot: snapshot, selectedSkills: [selectedSkill] })
      ).rejects.toThrow(/invalid selected skill/)
    }
  })
})

describe('scanSkillsCliCell', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'skills-cli-scan-'))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  function bundle(prefix: string, name: string, manifest = true): string {
    const path = join(cwd, ...prefix.split('/').filter(Boolean), 'skills', name)
    mkdirSync(path, { recursive: true })
    if (manifest) writeFileSync(join(path, 'SKILL.md'), 'skill')
    return path
  }

  it('discovers and sorts structurally safe upstream layouts without a runtime path map', () => {
    bundle('data', 'data-bundle')
    bundle('.foo', 'hidden-bundle')
    bundle('', 'direct-bundle')
    bundle('.tabnine/agent', 'tabnine-bundle')
    bundle('agent', 'agent-bundle')

    const bundles = scanSkillsCliCell(cwd).bundles
    expect(bundles.map((entry) => entry.relativePath)).toEqual(
      [
        'skills/direct-bundle',
        'agent/skills/agent-bundle',
        'data/skills/data-bundle',
        '.tabnine/agent/skills/tabnine-bundle',
        '.foo/skills/hidden-bundle'
      ].sort((left, right) => left.localeCompare(right))
    )
    expect(bundles.map(({ relativePath, root }) => ({ relativePath, root }))).toEqual(
      expect.arrayContaining([
        { relativePath: 'skills/direct-bundle', root: '' },
        { relativePath: 'agent/skills/agent-bundle', root: 'agent' },
        { relativePath: '.tabnine/agent/skills/tabnine-bundle', root: '.tabnine/agent' }
      ])
    )
  })

  it('allows only a bounded regular root lockfile outside discovered bundles', () => {
    bundle('.runtime', 'skill')
    writeFileSync(join(cwd, 'skills-lock.json'), '{}')
    expect(scanSkillsCliCell(cwd, { maxLockBytes: 2 }).lockFile).toBe(join(cwd, 'skills-lock.json'))

    writeFileSync(join(cwd, 'skills-lock.json'), '123')
    expect(() => scanSkillsCliCell(cwd, { maxLockBytes: 2 })).toThrow('lockfile is not a bounded regular file')

    writeFileSync(join(cwd, 'skills-lock.json'), '{}')
    writeFileSync(join(cwd, 'debug.log'), 'unexpected')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/file outside a bundle.*debug\.log/)
  })

  it('rejects files in layout prefixes and lockfiles below the cell root', () => {
    bundle('agent', 'skill')
    writeFileSync(join(cwd, 'agent', 'debug.log'), 'unexpected')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/file outside a bundle.*agent\/debug\.log/)

    rmSync(join(cwd, 'agent', 'debug.log'))
    writeFileSync(join(cwd, 'agent', 'skills-lock.json'), '{}')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/file outside a bundle.*agent\/skills-lock\.json/)
  })

  it('rejects a missing direct SKILL.md', () => {
    bundle('.runtime', 'skill', false)
    expect(() => scanSkillsCliCell(cwd)).toThrow('missing SKILL.md')
  })

  it('rejects symlinks and special entries inside a bundle', () => {
    const path = bundle('.runtime', 'skill')
    symlinkSync(join(path, 'SKILL.md'), join(path, 'alias'))
    expect(() => scanSkillsCliCell(cwd)).toThrow('link or special file')
  })

  it.each(['.git', '.Git', '.agentconnect', '.AgentConnect'])('rejects reserved first segment %s', (reserved) => {
    bundle(reserved, 'skill')
    expect(() => scanSkillsCliCell(cwd)).toThrow(`reserved skills CLI first segment: ${reserved}`)
  })

  it.each([
    ['non-ASCII', 'café'],
    ['dot-only', '...'],
    ['trailing-dot', 'unsafe.']
  ])('rejects %s layout segments', (_label, unsafe) => {
    bundle(unsafe, 'skill')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/unsafe skills CLI layout segment/)
  })

  it.runIf(process.platform !== 'win32')('rejects backslashes in layout and nested bundle segments', () => {
    bundle('bad\\segment', 'skill')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/unsafe skills CLI layout segment/)

    rmSync(join(cwd, 'bad\\segment'), { recursive: true, force: true })
    const path = bundle('.runtime', 'skill')
    writeFileSync(join(path, 'bad\\name'), 'unsafe')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/unsafe path segment/)
  })

  it('rejects unsafe bundle names and non-ASCII nested path segments', () => {
    bundle('.runtime', 'café')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/unsafe skills CLI bundle name/)

    rmSync(join(cwd, '.runtime'), { recursive: true, force: true })
    const path = bundle('.runtime', 'skill')
    writeFileSync(join(path, 'café'), 'unsafe')
    expect(() => scanSkillsCliCell(cwd)).toThrow(/unsafe path segment/)
  })

  it('enforces configurable file and byte caps', () => {
    const path = bundle('.runtime', 'skill')
    writeFileSync(join(path, 'extra'), '12345')
    expect(() => scanSkillsCliCell(cwd, { maxFilesPerBundle: 1 })).toThrow('too many files')
    expect(() => scanSkillsCliCell(cwd, { maxFileBytes: 4 })).toThrow('oversized file')
  })

  it('applies depth and entry caps to layout prefixes as well as bundle contents', () => {
    bundle('one/two/three', 'skill')
    expect(() => scanSkillsCliCell(cwd, { maxDepth: 4 })).toThrow('depth limit')
    expect(() => scanSkillsCliCell(cwd, { maxEntries: 4 })).toThrow('too many entries')
  })

  it('rejects an empty cell', () => {
    expect(() => scanSkillsCliCell(cwd)).toThrow(SkillsCliCellError)
  })
})

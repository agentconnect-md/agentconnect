import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseEnv, promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { inspectEnvFile, preflightEnvFile, readEnvFileValues, writeEnvFile } from '../src/env-file.js'

describe('environment file writes', () => {
  it('preserves existing content and safely appends values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-'))
    const path = join(directory, '.env')
    const original = '# Keep this comment\nEXISTING=value'
    const secret = 'line one\n"line two"\\tail'
    await writeFile(path, original, { mode: 0o644 })

    const result = await writeEnvFile(path, {
      CREATED_ID: '123',
      CREATED_SECRET: secret
    })

    expect(isAbsolute(result)).toBe(true)
    const source = await readFile(path, 'utf8')
    expect(source).toBe(`${original}\nCREATED_ID='123'\nCREATED_SECRET='${secret}'\n`)
    expect(parseEnv(source)).toMatchObject({ CREATED_ID: '123', CREATED_SECRET: secret })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('creates missing parent directories and a private file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-'))
    const path = join(directory, 'nested', 'configuration', '.env')

    await expect(preflightEnvFile(path, ['NEW_KEY'])).resolves.toBe(path)
    await expect(writeEnvFile(path, { NEW_KEY: '' })).resolves.toBe(path)

    expect(await readFile(path, 'utf8')).toBe("NEW_KEY=''\n")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('fails before changing a file when any requested key exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-'))
    const path = join(directory, '.env')
    const original = '# existing provider\nexport CREATED_ID = old-id\nOTHER=value\n'
    const newSecret = 'must-never-appear-in-errors'
    await writeFile(path, original)

    await expect(preflightEnvFile(path, ['CREATED_ID', 'CREATED_SECRET'])).rejects.toThrow('already defines CREATED_ID')
    await expect(writeEnvFile(path, { CREATED_ID: 'new-id', CREATED_SECRET: newSecret })).rejects.not.toThrow(newSecret)
    expect(await readFile(path, 'utf8')).toBe(original)
  })

  it('distinguishes complete and partial provider configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-'))
    const path = join(directory, '.env')
    await writeFile(path, 'FIRST=one\n')

    await expect(inspectEnvFile(path, ['FIRST', 'SECOND'])).resolves.toMatchObject({
      defined: ['FIRST'],
      present: ['FIRST'],
      missing: ['SECOND']
    })
    await writeFile(path, 'FIRST=one\nSECOND=two\n')
    await expect(inspectEnvFile(path, ['FIRST', 'SECOND'])).resolves.toMatchObject({
      defined: ['FIRST', 'SECOND'],
      present: ['FIRST', 'SECOND'],
      missing: []
    })
    await expect(readEnvFileValues(path, ['SECOND'])).resolves.toEqual({ SECOND: 'two' })
  })

  it('treats empty placeholders as partial configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-'))
    const path = join(directory, '.env')
    await writeFile(path, 'FIRST=\nSECOND=two\n')

    await expect(inspectEnvFile(path, ['FIRST', 'SECOND'])).resolves.toMatchObject({
      defined: ['FIRST', 'SECOND'],
      present: ['SECOND'],
      missing: ['FIRST']
    })
  })

  it('refuses to follow an existing symbolic link', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-'))
    const target = join(directory, 'target.env')
    const path = join(directory, '.env')
    await writeFile(target, 'UNCHANGED=value\n')
    await symlink(target, path)

    await expect(preflightEnvFile(path, ['NEW_KEY'])).rejects.toThrow('is a symbolic link')
    await expect(writeEnvFile(path, { NEW_KEY: 'secret' })).rejects.toThrow('is a symbolic link')
    expect(await readFile(target, 'utf8')).toBe('UNCHANGED=value\n')
  })

  it('writes only to ignored files inside a Git worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentconnect-env-git-'))
    const runGit = (...args: string[]) => promisify(execFile)('git', ['-C', directory, ...args])
    await runGit('init', '--quiet')
    await writeFile(join(directory, '.gitignore'), '.env\n')
    await writeFile(join(directory, 'tracked.env'), 'EXISTING=value\n')
    await runGit('add', '.gitignore', 'tracked.env')

    await expect(writeEnvFile(join(directory, '.env'), { NEW_KEY: 'secret' })).resolves.toBe(join(directory, '.env'))
    await expect(writeEnvFile(join(directory, 'tracked.env'), { NEW_KEY: 'secret' })).rejects.toThrow(
      'is tracked by Git'
    )
    await expect(writeEnvFile(join(directory, 'unignored.env'), { NEW_KEY: 'secret' })).rejects.toThrow(
      'is not ignored by Git'
    )
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CODE_HOST_PROVIDERS } from '@agentconnect.md/protocol'
import { codeHostRepository } from '../src/codehost/repository.js'

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../src/${path}`, import.meta.url)), 'utf8')
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const withoutRegistry = (text: string) => text.replace(/const MODULES:[\s\S]*?\n}\n/, '')

const CORE = ['codehost/repository.ts', 'codehost/ref-resolver.ts', 'source-cache/authorize-read.ts']
const NEW = [...CORE, 'codehost/rest-read.ts', 'github/repository.ts', 'github/rest.ts', 'gitlab/repository.ts']

describe('code-host repository seam', () => {
  it('maps every provider, and each module owns its own key', () => {
    for (const provider of CODE_HOST_PROVIDERS) {
      const module = codeHostRepository(provider)
      if (module) expect(module.provider).toBe(provider)
    }
    expect(codeHostRepository('github')).toBeDefined()
    expect(codeHostRepository('gitlab')).toBeDefined()
  })

  it('keeps provider names and switches out of core', () => {
    for (const file of CORE) {
      const body = withoutRegistry(withoutComments(src(file)))
      for (const provider of CODE_HOST_PROVIDERS) expect(body, file).not.toContain(`'${provider}'`)
      expect(body, file).not.toMatch(/switch\s*\(/)
      expect(body, file).not.toMatch(/provider\s*===?\s*'/)
    }
  })

  it('never spawns Git or borrows the skill credential helper', () => {
    for (const file of NEW) {
      const body = src(file)
      expect(body, file).not.toMatch(/node:child_process/)
      expect(body, file).not.toMatch(/loadScopedGitSkillCredential|skill-git-source/)
    }
  })
})

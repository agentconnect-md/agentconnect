// Daemon-owned builtin skills (webchat-generated-images.md §3): versioned with the daemon, installed through the ordinary ledger.
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalSkillSource } from './install-skills.js'

/** The reserved name of the image generate-and-share workflow. */
export const BUILTIN_IMAGES_SKILL = 'agentconnect-images'

/** Source keys of builtin skills start here, so receipts and inventories can tell them apart. */
export const BUILTIN_SKILL_KEY_PREFIX = 'builtin:'

let cached: Promise<LocalSkillSource[]> | undefined

/** The packaged skill directories: beside the bundle in dist, or the package's own builtin-skills in source. */
async function builtinSkillDir(name: string): Promise<string | undefined> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [
    join(moduleDir, 'builtin-skills', name),
    join(moduleDir, '..', '..', 'builtin-skills', name)
  ]) {
    try {
      return await realpath(candidate)
    } catch {
      // Try the next fixed, daemon-owned layout.
    }
  }
  return undefined
}

async function loadBuiltinSkillSources(): Promise<LocalSkillSource[]> {
  const sources: LocalSkillSource[] = []
  for (const name of [BUILTIN_IMAGES_SKILL]) {
    const sourceDir = await builtinSkillDir(name)
    if (!sourceDir) continue
    const digest = createHash('sha256')
      .update(await readFile(join(sourceDir, 'SKILL.md')))
      .digest('hex')
    sources.push({
      kind: 'managed',
      key: `${BUILTIN_SKILL_KEY_PREFIX}${name}:${digest}`,
      name,
      sourceDir,
      contentDigest: digest
    })
  }
  return sources
}

/** The builtin skill sources this daemon ships; empty when the package lacks them, never a startup failure. */
export function builtinSkillSources(): Promise<LocalSkillSource[]> {
  cached ??= loadBuiltinSkillSources().catch(() => [])
  return cached
}

/** Builtins win their reserved names and install last; a same-named configured source is dropped with a diagnosis. */
export function reserveBuiltinSkills(sources: LocalSkillSource[], warn: (message: string) => void): LocalSkillSource[] {
  const builtins = sources.filter((source) => source.key.startsWith(BUILTIN_SKILL_KEY_PREFIX))
  const reserved = new Set(builtins.map((source) => source.name))
  const kept = sources.filter((source) => {
    if (source.key.startsWith(BUILTIN_SKILL_KEY_PREFIX)) return false
    if (!reserved.has(source.name)) return true
    warn(
      `skills: "${source.name}" is reserved for the daemon's builtin skill; the source ${source.key} is not installed`
    )
    return false
  })
  return [...kept, ...builtins]
}

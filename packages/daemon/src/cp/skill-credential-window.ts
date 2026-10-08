// Skill credential windows (source-cache.md §8): private skill tokens are minted only while the daemon holds one open.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SKILLS_RECONCILE_TIMEOUT_MS } from '../shim/skill-protocol.js'

/** The subject of a window the daemon opens for Git it runs itself, as opposed to a pod's. */
export const DAEMON_SKILL_WINDOW_SUBJECT = 'daemon'

/** No window outlives the skills request it serves. */
export const MAX_SKILL_WINDOW_TTL_MS = SKILLS_RECONCILE_TIMEOUT_MS

export interface SkillCredentialWindowSpec {
  agentId: string
  /** The sandbox subject the capability is handed to, or DAEMON_SKILL_WINDOW_SUBJECT. */
  subject: string
  /** The exact private skill repositories ("owner/repo") the window admits. */
  repos: readonly string[]
  /** Clamped to MAX_SKILL_WINDOW_TTL_MS. */
  ttlMs?: number
}

export interface SkillCredentialWindow {
  /** Daemon-minted bearer for this window alone; never the per-agent capability, never logged. */
  readonly capability: string
  readonly agentId: string
  readonly subject: string
  readonly repos: readonly string[]
  close(): void
}

interface OpenWindow {
  id: number
  agentId: string
  subject: string
  repos: Set<string>
  digest: Buffer
  expiresAt: number
}

/** A live window as an admission sees it. */
export interface AdmittedSkillWindow {
  agentId: string
  subject: string
  covers(repo: string): boolean
}

const digestOf = (capability: string): Buffer => createHash('sha256').update(capability, 'utf8').digest()

export class SkillCredentialWindows {
  private readonly windows = new Map<number, OpenWindow>()
  private nextId = 1

  constructor(private readonly now: () => number = Date.now) {}

  open(spec: SkillCredentialWindowSpec): SkillCredentialWindow {
    const repos = [...new Set(spec.repos.map((repo) => repo.toLowerCase()))]
    if (repos.length === 0) throw new Error('a skill credential window must name at least one repository')
    const ttl = Math.min(Math.max(spec.ttlMs ?? MAX_SKILL_WINDOW_TTL_MS, 0), MAX_SKILL_WINDOW_TTL_MS)
    const capability = randomBytes(32).toString('base64url')
    const id = this.nextId++
    this.windows.set(id, {
      id,
      agentId: spec.agentId,
      subject: spec.subject,
      repos: new Set(repos),
      digest: digestOf(capability),
      expiresAt: this.now() + ttl
    })
    return {
      capability,
      agentId: spec.agentId,
      subject: spec.subject,
      repos,
      close: () => {
        this.windows.delete(id)
      }
    }
  }

  /** The live window `capability` opens for `agentId`, compared in constant time; expired ones are dropped. */
  admit(agentId: string, capability: string | undefined): AdmittedSkillWindow | undefined {
    if (!capability) return undefined
    const presented = digestOf(capability)
    const now = this.now()
    let found: OpenWindow | undefined
    for (const window of [...this.windows.values()]) {
      if (window.expiresAt <= now) {
        this.windows.delete(window.id)
        continue
      }
      if (timingSafeEqual(window.digest, presented) && window.agentId === agentId) found = window
    }
    if (!found) return undefined
    const repos = found.repos
    return { agentId: found.agentId, subject: found.subject, covers: (repo) => repos.has(repo.toLowerCase()) }
  }

  /** Close every window of one agent (agent removed or its capability revoked). */
  closeAgent(agentId: string): void {
    for (const window of [...this.windows.values()]) if (window.agentId === agentId) this.windows.delete(window.id)
  }

  closeAll(): void {
    this.windows.clear()
  }

  /** Open windows, expired ones included until the next admission prunes them. */
  size(): number {
    return this.windows.size
  }
}

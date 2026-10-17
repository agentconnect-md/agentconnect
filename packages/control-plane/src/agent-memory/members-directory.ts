// The people directory as the console reads and clears it (assistant-mode.md §5.17): a person's own entries, and a clear in a Control-Plane home's tables.
import { randomUUID } from 'node:crypto'
import {
  MEMBERS_DIRECTORY_FILE,
  MEMBERS_OPT_OUT_PATH,
  parseMembersOptOut,
  renderMembersOptOut,
  withoutMembersEntries
} from '@agentconnect.md/protocol'
import type { AgentId, OrgId } from '../domain/ids.js'
import type { AgentMemoryFileRepo } from '../persistence/ports.js'

const MEMBERS_PATH = `memory/${MEMBERS_DIRECTORY_FILE}`
const MAX_READ_BYTES = 1024 * 1024
const APPEND_CHUNK_BYTES = 32 * 1024
const ATTEMPTS = 3

/** A chat identity a console user linked, as the identity provider names it. */
export interface LinkedChatIdentityRef {
  platform: string
  /** The provider's tenant: a workspace, a region, or `global` for ids unique across the platform. */
  tenant: string
  memberId: string
}

/** Whether a directory key names a chat identity the console user linked: same platform and member, a tenant that is or contains theirs. */
export function keyMatchesLinkedIdentity(key: string, link: LinkedChatIdentityRef): boolean {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first < 0 || last <= first || key.slice(0, first) !== link.platform || key.slice(last + 1) !== link.memberId)
    return false
  const tenant = key.slice(first + 1, last)
  return link.tenant === 'global' || tenant === link.tenant || tenant.startsWith(`${link.tenant}:`)
}

/** The keys among the directory's that are the console user's: their console key, and every linked identity an entry is keyed by. */
export function ownDirectoryKeys(
  userId: string,
  entryKeys: readonly string[],
  links: readonly LinkedChatIdentityRef[]
): string[] {
  const own = new Set([`user:${userId}`])
  for (const key of entryKeys) if (links.some((link) => keyMatchesLinkedIdentity(key, link))) own.add(key)
  return [...own]
}

type Files = Pick<AgentMemoryFileRepo, 'read' | 'append' | 'commit'>

async function readText(files: Files, agentId: AgentId, path: string): Promise<{ text: string; mtime: Date } | null> {
  const file = await files.read(agentId, path, 0, MAX_READ_BYTES)
  if (!file) return null
  if (file.size > file.slice.length) throw new Error(`${path} is larger than a directory file may be`)
  return { text: Buffer.from(file.slice).toString('utf8'), mtime: file.mtime }
}

/** Publish `text` at `path` the way a daemon's write lands: a staged temp beside it, committed while `ifMatch` holds; false on a conflict. */
async function put(
  files: Files,
  agentId: AgentId,
  orgId: OrgId,
  path: string,
  text: string,
  ifMatch: Date | undefined,
  now: Date
): Promise<boolean> {
  const temp = `${path.slice(0, path.lastIndexOf('/'))}/.agentconnect-memory-${randomUUID()}.tmp`
  const bytes = Buffer.from(text)
  let offset = 0
  do {
    const appended = await files.append(
      agentId,
      orgId,
      temp,
      bytes.subarray(offset, offset + APPEND_CHUNK_BYTES),
      offset === 0,
      now
    )
    if (!appended.ok) throw new Error(`${path} could not be staged (${appended.reason})`)
    offset += APPEND_CHUNK_BYTES
  } while (offset < bytes.length)
  const done = await files.commit(agentId, path, temp, ifMatch?.toISOString(), now, ifMatch === undefined)
  if (done.ok) return true
  if (done.reason === 'conflict') return false
  throw new Error(`${path} could not be published (${done.reason})`)
}

/** Read, change and publish one file, again on a conflict; `change` returns undefined to leave it. */
async function update(
  files: Files,
  agentId: AgentId,
  orgId: OrgId,
  path: string,
  change: (text: string | undefined) => string | undefined,
  now: Date
): Promise<boolean> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current = await readText(files, agentId, path)
    const next = change(current?.text)
    if (next === undefined || next === current?.text) return false
    if (await put(files, agentId, orgId, path, next, current?.mtime, now)) return true
  }
  throw new Error(`${path} kept changing; try again`)
}

/** In a Control-Plane home: mark `mark` opted out, then remove the entries keyed by `keys`; whether any entry was there. */
export async function clearMembersInTables(
  files: Files,
  agentId: AgentId,
  orgId: OrgId,
  keys: readonly string[],
  mark: readonly string[],
  now: Date
): Promise<boolean> {
  // The marker first, as on the daemon: a write racing the clear is then refused, never left standing.
  if (mark.length)
    await update(
      files,
      agentId,
      orgId,
      MEMBERS_OPT_OUT_PATH,
      (text) => {
        const marked = parseMembersOptOut(text)
        const before = marked.size
        for (const key of mark) if (!marked.has(key)) marked.set(key, now.toISOString().slice(0, 10))
        return marked.size === before ? undefined : renderMembersOptOut(marked)
      },
      now
    )
  return await update(
    files,
    agentId,
    orgId,
    MEMBERS_PATH,
    (text) => {
      if (text === undefined) return undefined
      const result = withoutMembersEntries(text, keys)
      return result.removed.length ? result.text : undefined
    },
    now
  )
}

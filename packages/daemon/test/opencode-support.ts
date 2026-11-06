import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** One `opencode auth export` entry for an API key sign-in. */
export function openCodeKeyEntry(provider: string, key: string, active = true) {
  return { id: `cre_${provider}`, integrationID: provider, label: provider, active, value: { type: 'key', key } }
}

/** A POSIX `opencode` on a PATH of its own whose `auth export` prints `entries`, rewritable between launches. */
export function fakeOpenCode(root: string, entries: unknown[] = []) {
  const bin = join(root, 'opencode-bin')
  mkdirSync(bin, { recursive: true })
  const exported = join(bin, 'export.json')
  const write = (next: unknown[]) => writeFileSync(exported, JSON.stringify(next))
  write(entries)
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\ncat '${exported}'\n`)
  chmodSync(join(bin, 'opencode'), 0o755)
  return { PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter), write }
}

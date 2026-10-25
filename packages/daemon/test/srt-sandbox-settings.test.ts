import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSandboxSettingsUnder } from '../src/acp/sandbox.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function settingsFor(policy: Parameters<typeof writeSandboxSettingsUnder>[2]): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), 'srt-settings-'))
  roots.push(root)
  const path = writeSandboxSettingsUnder(root, 'host', { ...policy, writable: [root], denyRead: [], allowRead: [] })
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('SRT settings', () => {
  it("lets an ordinary host's runtime nest its own sandbox", () => {
    const settings = settingsFor({ writable: [], denyRead: [], allowRead: [] })
    expect(settings.allowNestedUserNamespaces).toBe(true)
    expect(settings.filesystem).toMatchObject({ allowGitConfig: true })
  })

  it('keeps the offline helper from nesting, with its stricter denies', () => {
    const settings = settingsFor({ writable: [], denyRead: [], allowRead: [], offline: true })
    expect(settings).not.toHaveProperty('allowNestedUserNamespaces')
    expect(settings.filesystem).toMatchObject({ allowGitConfig: false })
    expect(settings.network).toMatchObject({ allowAllUnixSockets: false })
  })
})

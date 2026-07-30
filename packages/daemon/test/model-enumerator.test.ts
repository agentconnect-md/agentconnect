import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AcpHost } from '../src/acp/acp-host.js'
import type { RuntimeDef } from '../src/config/config-schema.js'
import { makeModelEnumerator } from '../src/runtimes/model-enumerator.js'
import type { ProbeHostPolicy } from '../src/runtimes/runtime-prober.js'

const runtime: RuntimeDef = { command: 'runtime', args: [], env: [] }

describe('makeModelEnumerator delegated private-root masks', () => {
  it('passes both daemon-private masks into the disposable bwrap host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-enumerator-mask-'))
    const maskedRoots = [join(root, 'broker'), join(root, 'webchat-hosts')]
    for (const maskedRoot of maskedRoots) mkdirSync(maskedRoot)
    let policy: ProbeHostPolicy | undefined
    try {
      const enumerate = makeModelEnumerator({
        sandboxMechanism: 'bwrap',
        maskedReadRoots: maskedRoots,
        hostFactory: (_runtime, _id, _cwd, supplied) => {
          policy = supplied
          return {
            start: async () => {},
            newSession: async () => 'session-1',
            sessionConfigOptions: () => [],
            stop: async () => {}
          } as unknown as AcpHost
        }
      })
      await enumerate('runtime', runtime, [], { totalMs: 5_000, perModelMs: 1_000 })
      expect(policy?.sandbox?.maskedReadRoots).toEqual(maskedRoots)
    } finally {
      const resolvedRoot = realpathSync(root)
      const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))
      expect(resolvedRoot.startsWith(repoRoot + sep)).toBe(false)
      rmSync(root, { recursive: true, force: true })
    }
  })
})

import { describe, it, expect } from 'vitest'
import { turnFailureCode } from '../../src/acp/acp-host.js'
import { PROFILES, profileById } from './profiles.js'
import { verdictFor } from './support-matrix.js'
import { bootHost, runDaemonTurn } from './harness.js'

/**
 * daemon ↔ ACP integration matrix.
 *
 * A grid of {daemon ACP feature} × {ACP agent profile}, every cell run against a REAL
 * subprocess (the scenario-driven fixture). Each profile emulates one real ACP-registry
 * agent's capability surface (profiles.ts); each feature asserts either the working
 * behavior ('run') or graceful degradation ('degrade') depending on whether the profile
 * advertises the capability (support-matrix.ts).
 *
 * The point this makes that a single-fixture test can't: the daemon's ACP handling is
 * correct across the VARIETY of runtimes it targets — a capability one agent has and
 * another lacks is either used or degrades cleanly, never crashes or hangs.
 */

const TIMEOUT = 20_000

describe.each(PROFILES)('ACP matrix · $id ($registryId)', (profile) => {
  it(
    'capabilities: initialize + session/new advertise the expected surface',
    async () => {
      const h = await bootHost(profile)
      try {
        expect(h.host.loadSupported()).toBe(profile.caps.loadSession)
        expect(h.host.mcpCapabilities()).toEqual(profile.caps.mcp)
        expect(h.host.promptSupports('image')).toBe(profile.caps.promptImage)
        await h.host.newSession('/tmp')
        expect(h.host.modelOptions()?.models ?? null).toEqual(profile.caps.models)
        expect(h.host.permissionModeOptions()?.modes ?? null).toEqual(profile.caps.permissionModes)
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    'lifecycle: session/new → prompt streams a reply and ends the turn',
    async () => {
      const h = await bootHost(profile)
      try {
        const sid = await h.host.newSession('/tmp')
        const res = await h.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        expect(res.stopReason).toBe('end_turn')
        expect(h.texts().some((t) => t.includes('echo:hi'))).toBe(true)
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    `model-switch [${verdictFor('model-switch', profile)}]`,
    async () => {
      const h = await bootHost(profile)
      try {
        const sid = await h.host.newSession('/tmp')
        if (verdictFor('model-switch', profile) === 'run') {
          const target = profile.caps.models!.find((m) => m !== h.host.modelOptions()?.current)!
          expect(await h.host.setSessionModel(sid, target)).toBe(true)
          expect(h.host.modelOptions()?.current).toBe(target)
        } else {
          // No model selector — the daemon reports "not applied" rather than throwing.
          expect(await h.host.setSessionModel(sid, 'anything')).toBe(false)
        }
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    `permission-mode-switch [${verdictFor('permission-mode-switch', profile)}]`,
    async () => {
      const h = await bootHost(profile)
      try {
        const sid = await h.host.newSession('/tmp')
        if (verdictFor('permission-mode-switch', profile) === 'run') {
          const target = profile.caps.permissionModes!.find((m) => m !== h.host.permissionModeOptions()?.current)!
          expect(await h.host.setSessionPermissionMode(sid, target)).toBe(true)
          expect(h.host.permissionModeOptions()?.current).toBe(target)
        } else {
          expect(await h.host.setSessionPermissionMode(sid, 'anything')).toBe(false)
        }
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    `load-resume [${verdictFor('load-resume', profile)}]`,
    async () => {
      const h = await bootHost(profile)
      try {
        if (verdictFor('load-resume', profile) === 'run') {
          expect(h.host.loadSupported()).toBe(true)
          await h.host.loadSession('persisted-1', '/tmp')
          // Restored-title metadata is forwarded…
          expect(h.updates.some((u) => u.update?.sessionUpdate === 'session_info_update')).toBe(true)
          // …but replayed conversation output is suppressed.
          expect(h.texts().some((t) => t.includes('historical output'))).toBe(false)
        } else {
          // Unsupported: the daemon sees loadSession=false and would recreate instead.
          expect(h.host.loadSupported()).toBe(false)
        }
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    'interactive-permission: resolver choice wins; absent resolver auto-allows (never hangs)',
    async () => {
      const permOptions = {
        options: [
          { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Deny', kind: 'reject_once' }
        ]
      }
      // (a) No resolver → daemon auto-allows the first allow option.
      const auto = await bootHost(profile, { override: { prompt: { requestPermission: permOptions } } })
      try {
        const sid = await auto.host.newSession('/tmp')
        await auto.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        expect(auto.texts().some((t) => t.includes('"outcome":"selected"') && t.includes('"yes"'))).toBe(true)
        expect(auto.permissionEvents.map(({ event }) => event)).toEqual([
          { kind: 'requested' },
          expect.objectContaining({
            kind: 'resolved',
            source: 'fallback',
            fallbackReason: 'no_resolver',
            response: { outcome: { outcome: 'selected', optionId: 'yes' } }
          })
        ])
      } finally {
        await auto.stop()
      }
      // (b) Interactive resolver → the user's explicit choice is forwarded.
      const interactive = await bootHost(profile, {
        override: { prompt: { requestPermission: permOptions } },
        onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'no' } })
      })
      try {
        const sid = await interactive.host.newSession('/tmp')
        await interactive.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        expect(interactive.texts().some((t) => t.includes('"no"'))).toBe(true)
        expect(interactive.permissionEvents.map(({ event }) => event)).toEqual([
          { kind: 'requested' },
          {
            kind: 'resolved',
            source: 'resolver',
            response: { outcome: { outcome: 'selected', optionId: 'no' } }
          }
        ])
      } finally {
        await interactive.stop()
      }
    },
    TIMEOUT
  )

  it(
    'elicitation: absent resolver declines (never hangs); resolver accepts',
    async () => {
      // ACP elicitation/create (form mode): mode + message + requestedSchema; the fixture
      // adds the session scope. Absent an onElicit resolver the daemon declines.
      const elicit = { mode: 'form', message: 'Pick one', requestedSchema: { type: 'object', properties: {} } }
      const declined = await bootHost(profile, { override: { prompt: { elicit } } })
      try {
        const sid = await declined.host.newSession('/tmp')
        await declined.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        expect(declined.texts().some((t) => t.includes('"action":"decline"'))).toBe(true)
      } finally {
        await declined.stop()
      }
      const accepted = await bootHost(profile, {
        override: { prompt: { elicit } },
        onElicit: async () => ({ action: 'accept', content: { choice: 'a' } })
      })
      try {
        const sid = await accepted.host.newSession('/tmp')
        await accepted.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        expect(accepted.texts().some((t) => t.includes('"action":"accept"'))).toBe(true)
      } finally {
        await accepted.stop()
      }
    },
    TIMEOUT
  )

  it(
    `usage-fold [${verdictFor('usage-fold', profile)}]`,
    async () => {
      const h = await bootHost(profile)
      try {
        const sid = await h.host.newSession('/tmp')
        const res = await h.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        if (verdictFor('usage-fold', profile) === 'run') {
          expect(res.usage).toBeDefined()
          expect(typeof res.usage!.used).toBe('number')
          expect(res.usage!.size).toBeGreaterThan(0)
        } else {
          expect(res.usage).toBeUndefined()
        }
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    `memory: fresh-session index routing [${verdictFor('memory', profile)}]`,
    async () => {
      const h = await bootHost(profile, { override: { prompt: { echoSysMeta: true } } })
      try {
        // The routing decision the daemon makes per runtime.
        expect(h.host.usesMetaSystemPrompt()).toBe(verdictFor('memory', profile) === 'run')
        // `systemAppend` is the fresh-session memory index the daemon threads in.
        const sid = await h.host.newSession('/tmp', [], undefined, 'MEMORY-INDEX')
        await h.host.prompt(sid, [{ type: 'text', text: 'hi' }])
        const sysmeta = h.texts().find((t) => t.startsWith('sysmeta:'))
        expect(sysmeta).toBeDefined()
        if (verdictFor('memory', profile) === 'run') {
          // Claude: the index rides _meta.systemPrompt.append on session/new — standing
          // context, NOT a user turn.
          expect(sysmeta).toContain('MEMORY-INDEX')
        } else {
          // Others: nothing is smuggled via _meta; the daemon routes the index as a
          // leading inline block instead (outside AcpHost's scope).
          expect(sysmeta).toBe('sysmeta:null')
        }
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )
})

// ── Cross-cutting ACP behaviors (not capability-gated per profile) ────────────────

describe('ACP host: turn-failure classification', () => {
  it(
    'maps a provider quota error to provider_quota_exhausted',
    async () => {
      const claude = profileById('claude')
      const h = await bootHost(claude, {
        override: { prompt: { error: { message: 'You have exceeded your current quota.' } } }
      })
      try {
        const sid = await h.host.newSession('/tmp')
        const err = await h.host.prompt(sid, [{ type: 'text', text: 'hi' }]).then(
          () => null,
          (e) => e
        )
        expect(err).not.toBeNull()
        expect(turnFailureCode(err)).toBe('provider_quota_exhausted')
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )

  it(
    'leaves a generic failure as turn_failed',
    async () => {
      const claude = profileById('claude')
      const h = await bootHost(claude, { override: { prompt: { error: { message: 'something broke' } } } })
      try {
        const sid = await h.host.newSession('/tmp')
        const err = await h.host.prompt(sid, [{ type: 'text', text: 'hi' }]).then(
          () => null,
          (e) => e
        )
        expect(turnFailureCode(err)).toBe('turn_failed')
      } finally {
        await h.stop()
      }
    },
    TIMEOUT
  )
})

describe('ACP host: stop() escalation', () => {
  it(
    'a well-behaved agent stops on graceful EOF + SIGTERM',
    async () => {
      const h = await bootHost(profileById('claude'))
      await expect(h.host.stop(5000)).resolves.toBeUndefined()
    },
    TIMEOUT
  )

  it(
    'a SIGTERM-ignoring agent is reaped by the SIGKILL fallback (never hangs)',
    async () => {
      const h = await bootHost(profileById('claude'), { override: { ignoreSigterm: true } })
      // Must resolve via the SIGKILL fallback rather than hang past the deadline.
      await expect(h.host.stop(500)).resolves.toBeUndefined()
    },
    TIMEOUT
  )
})

describe('daemon end-to-end: webchat turn through a real ACP subprocess', () => {
  // A representative slice: full-featured, no-loadSession, and bare-minimum agents.
  it.each([profileById('claude'), profileById('codex'), profileById('pi')])(
    'streams the reply and closes the turn ($id)',
    async (profile) => {
      const { reply, stop } = await runDaemonTurn(profile, 'go')
      try {
        expect(reply.texts.some((t) => t.includes('go'))).toBe(true)
        expect(reply.dones.at(-1)?.stopReason).toBe('end_turn')
      } finally {
        await stop()
      }
    },
    30_000
  )
})

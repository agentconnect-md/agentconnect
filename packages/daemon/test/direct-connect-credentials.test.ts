import { describe, expect, it, vi } from 'vitest'
import { HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED } from '@agentconnect.md/protocol'
import { turnFailureCode } from '../src/acp/acp-host.js'
import { K8sDriver } from '../src/k8s/driver.js'
import { RUNTIME_GRANTS } from '../src/k8s/sandbox-identity.js'
import { K8sApiError } from '@agentconnect.md/k8s-client'
import type { Sandbox, SandboxClaim } from '../src/k8s/sandbox-api.js'
import { fakeGenerations } from './fake-generations.js'
import type { ShimConnection } from '../src/shim/connection.js'

/**
 * The direct-connect stage: the runtime reaches its provider itself, so provider credentials
 * travel the same paths they always did and only their DELIVERY changes.
 *
 * Two things must hold. Credential material must never reach a Kubernetes object — a claim
 * carrying env bypasses warm-pool adoption, and a pool pod is stamped from the template
 * before any user exists, so a template env value would be visible to whoever is adopted
 * next. And an upstream rejection must be explainable, or a user with an expired key sees
 * only "turn failed".
 */

const SECRET = 'sk-ant-not-a-real-key-000000'

function fakeApi() {
  const created: SandboxClaim[] = []
  return {
    created,
    api: {
      ensureClaim: async (claim: SandboxClaim & { metadata: { name: string } }) => {
        created.push(claim)
        return { ...claim, status: { sandbox: { name: 'sb-1' } } }
      },
      getClaim: async () => {
        const claim = created[0]
        if (!claim) throw new K8sApiError(404, 'NotFound', 'no claim')
        return { ...claim, status: { sandbox: { name: 'sb-1' } } }
      },
      deleteClaim: async () => {},
      getSandbox: async () =>
        ({
          metadata: { name: 'sb-1', uid: 'sandbox-uid-1' },
          spec: { operatingMode: 'Running' },
          status: { conditions: [{ type: 'Ready', status: 'True' }], podIPs: ['10.0.0.8'] }
        }) as Sandbox,
      setOperatingMode: async () => ({}) as Sandbox,
      watchClaims: vi.fn(),
      reviewToken: vi.fn()
    }
  }
}

describe('provider credentials in the direct-connect stage', () => {
  it('never writes credential material into the Kubernetes claim', async () => {
    const { api, created } = fakeApi()
    const driver = new K8sDriver({
      api: api as never,
      orgForAgent: () => 'org-1',
      warmPoolName: 'pool',
      generations: fakeGenerations(),
      connectChannel: async () => ({}) as ShimConnection,
      log: { info: () => {}, warn: () => {}, debug: () => {} }
    })
    // launch() must be what creates the claim: pre-creating it would take the existing-launch
    // fast path, so the request carrying the credential would never reach claim construction
    // and a future leak from launch into the claim would still pass.
    await driver
      .launch({ command: 'runtime', args: [], env: { AC_AGENT_ID: 'agent-a', ANTHROPIC_API_KEY: SECRET } })
      .catch(() => undefined)
    expect(created).toHaveLength(1)
    const serialized = JSON.stringify(created)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('ANTHROPIC_API_KEY')
    expect(serialized).not.toMatch(/"env"/)
    expect(serialized).not.toMatch(/volumeClaimTemplates/)
  })

  it('grants the runtime exactly the channels it needs and nothing else', () => {
    // The closed set admits only runtime channels that the daemon explicitly owns.
    expect([...RUNTIME_GRANTS].sort()).toEqual(['acp', 'automerge', 'exec', 'materialize', 'read', 'skills', 'tunnel'])
  })

  it('classifies a provider auth rejection by the type the provider itself sends', () => {
    // Anthropic and OpenAI both send a typed code; that identifies the provider, which an
    // HTTP number does not.
    expect(turnFailureCode({ error: { type: 'authentication_error', message: 'invalid x-api-key' } })).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
    expect(turnFailureCode({ data: { error: { code: 'invalid_api_key' } } })).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
    expect(turnFailureCode(new Error('Incorrect API key provided: sk-***'))).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
  })

  it("recognises Gemini's envelope, whose message and reason are shaped unlike the others", () => {
    // Documented Google shape: the wording is reversed relative to every other provider, and
    // the machine-readable reason sits inside a `details` ARRAY — which the signal collector
    // previously treated as a leaf and never entered.
    const gemini = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
      }
    }
    expect(turnFailureCode(gemini)).toBe(HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED)
    // The reason alone is enough, without the message.
    expect(turnFailureCode({ error: { details: [{ reason: 'API_KEY_INVALID' }] } })).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
  })

  it('does not classify our OWN shim rejection reason as a provider problem', () => {
    // The shim answers a refused handshake with reason `unauthenticated`, and failureSignals
    // collects `reason`. Treating that as provider auth would repeat the K8s-403 mistake with
    // a different field.
    expect(turnFailureCode({ type: 'shim/rejected', reason: 'unauthenticated', message: 'not accepted' })).toBe(
      'turn_failed'
    )
    expect(turnFailureCode({ reason: 'permission_error' })).toBe('turn_failed')
  })

  it('does NOT treat an unrelated 403 as a provider credential problem', () => {
    // The defect an earlier revision of this PR introduced. K8sApiError carries a numeric
    // status, and turnFailureCode sees failures from far beyond the model call — so matching
    // on 401/403 told users their provider key was bad when Kubernetes RBAC had denied a
    // claim. A status belongs to whichever layer produced it, so it is not evidence.
    const rbacDenial = new K8sApiError(403, 'Forbidden', 'sandboxclaims is forbidden: cannot create')
    expect(turnFailureCode(rbacDenial)).toBe('turn_failed')
    expect(turnFailureCode({ status: 401, message: 'Unauthorized' })).toBe('turn_failed')
    expect(turnFailureCode({ data: { response: { statusCode: 403 } } })).toBe('turn_failed')
  })

  it('survives a hostile getter while classifying, keeping the original failure', () => {
    // The classifier runs while handling someone else's error; throwing from it would replace
    // the failure a user needs to see with one about our own traversal.
    const hostile = new Error('the original failure')
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('getter exploded')
      }
    })
    Object.defineProperty(hostile, 'data', {
      get() {
        throw new Error('getter exploded')
      }
    })
    expect(() => turnFailureCode(hostile)).not.toThrow()
    expect(turnFailureCode(hostile)).toBe('turn_failed')
  })

  it('still recognises the message-shaped auth failures it always did', () => {
    expect(turnFailureCode(new Error('OAuth session expired and could not be refreshed'))).toBe(
      HOOK_REPORT_REASON_PROVIDER_AUTH_REQUIRED
    )
  })
})

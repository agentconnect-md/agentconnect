import { describe, expect, it } from 'vitest'
import { GitCredUnavailableError } from '../../src/cp/git-credential.js'
import { ShimRequestAbortedError } from '../../src/shim/channels.js'
import { GitTransportError } from '../../src/workspace/git-runner.js'
import { classifyReviewCheckoutFailure } from '../../src/github/review-checkout.js'

const cloneFailed = (cause: unknown) =>
  new Error('session clone of https://github.com/example-org/example-repo.git failed: x', { cause })

describe('classifyReviewCheckoutFailure', () => {
  it('reads the reason from anywhere in the cause chain', () => {
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    expect(classifyReviewCheckoutFailure(cloneFailed(new GitTransportError('This operation was aborted', abort)))).toBe(
      'fetch_timeout'
    )
    expect(
      classifyReviewCheckoutFailure(
        cloneFailed(new GitTransportError('x', new ShimRequestAbortedError('shim exec request aborted')))
      )
    ).toBe('fetch_timeout')
    expect(
      classifyReviewCheckoutFailure(
        cloneFailed(new GitTransportError('x', new Error('environment env-1 configuration changed while active')))
      )
    ).toBe('sandbox_conflict')
    expect(
      classifyReviewCheckoutFailure(
        new GitCredUnavailableError('control plane unreachable (client REGISTERING)', false)
      )
    ).toBe('credential_unavailable')
    expect(
      classifyReviewCheckoutFailure(new Error('workspace preparation blocked while agent authority is draining (a)'))
    ).toBe('authority_draining')
    expect(
      classifyReviewCheckoutFailure(new Error('github review head ref did not resolve to the requested SHA'))
    ).toBe('revision_mismatch')
  })

  it('falls back to other for anything unrecognized, including non-errors and cycles', () => {
    expect(classifyReviewCheckoutFailure('boom')).toBe('other')
    const cyclic: Error & { cause?: unknown } = new Error('first')
    cyclic.cause = cyclic
    expect(classifyReviewCheckoutFailure(cyclic)).toBe('other')
  })
})

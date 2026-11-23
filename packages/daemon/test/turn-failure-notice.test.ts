import { HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED } from '@agentconnect.md/protocol'
import { describe, expect, it } from 'vitest'
import { turnFailureReason, undecorateRuntimeError } from '../src/acp/acp-host.js'
import { outOfCredits, turnFailureCodeWithRefusal, turnFailureNotice } from '../src/daemon/turn-failure-notice.js'

const fixLink = (code: string) => `https://console.example.test/acme/agents/agent-1/out-of-credits?code=${code}`

// What each measured runtime hands up for a tagged gateway refusal (org-refusal-tag.md §4.2).
const RUNTIME_TEXTS = [
  'API Error: 402 [ERR:out_of_credits] Out of credits',
  'unexpected status 402 Payment Required: [ERR:out_of_credits] Out of credits, url: https://gateway.example.test/v1',
  'turn failed: [ERR:out_of_credits] Out of credits',
  '[ERR:out_of_credits] Out of credits'
]

describe('turnFailureNotice', () => {
  it.each(RUNTIME_TEXTS)('links Billing and the machine picker for %s', (text) => {
    const reason = turnFailureReason(new Error(text))
    const notice = turnFailureNotice(reason, { readsOrgRefusals: true, agentName: 'Helper', fixLink })
    expect(notice).toBe(
      [
        "⚠️ Your organization is out of credits, so Helper couldn't respond.",
        'Add credits, or move Helper to your own machine: https://console.example.test/acme/agents/agent-1/out-of-credits?code=out_of_credits'
      ].join('\n')
    )
  })

  it('tells an organization that never had credit to add some', () => {
    const notice = turnFailureNotice('[ERR:never_funded] No credit yet', {
      readsOrgRefusals: true,
      agentName: 'Helper',
      fixLink
    })
    expect(notice.split('\n')[0]).toBe("⚠️ Your organization hasn't added any credits yet, so Helper couldn't respond.")
    expect(notice).toContain('/agents/agent-1/out-of-credits?code=never_funded')
  })

  it('shows the text as before on a daemon that does not read refusals', () => {
    const reason = undecorateRuntimeError(RUNTIME_TEXTS[0]!)
    expect(turnFailureNotice(reason, { readsOrgRefusals: false, agentName: 'Helper', fixLink })).toBe(
      '⚠️ Agent failed to respond: [ERR:out_of_credits] Out of credits'
    )
  })

  it('shows unknown codes and untagged text as before', () => {
    for (const reason of ['[ERR:standing_lapsed] Standing lapsed', '[ERR:future_code] Refused', 'rate limited'])
      expect(turnFailureNotice(reason, { readsOrgRefusals: true, agentName: 'Helper', fixLink })).toBe(
        `⚠️ Agent failed to respond: ${reason}`
      )
  })
})

describe('turnFailureCodeWithRefusal', () => {
  it('classifies an out-of-credits refusal as a quota stop by its code', () => {
    const err = new Error('[ERR:out_of_credits] Something unusual')
    expect(outOfCredits(turnFailureReason(err), true)).toBe(true)
    expect(turnFailureCodeWithRefusal(err, turnFailureReason(err), true)).toBe(
      HOOK_REPORT_REASON_PROVIDER_QUOTA_EXHAUSTED
    )
    expect(turnFailureCodeWithRefusal(err, turnFailureReason(err), false)).toBe('turn_failed')
  })
})

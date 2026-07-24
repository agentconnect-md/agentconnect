import type { AssertionValueFunction } from 'promptfoo'

/** Score the observable answer without making an expected-low control fail the
 * Promptfoo process. Infrastructure/provider errors still fail the evaluation. */
const outcome: AssertionValueFunction = (output, context) => {
  const configured = context.vars.expected
  const expected = Array.isArray(configured) ? configured.map(String) : configured == null ? [] : [String(configured)]
  const normalized = output.trim()
  const matchMode = context.vars.match === 'exact' ? 'exact' : 'contains'
  const matched =
    expected.length === 0
      ? normalized.length > 0
      : matchMode === 'exact'
        ? expected.some((value) => normalized === value.trim())
        : expected.every((value) => normalized.toLowerCase().includes(value.toLowerCase()))
  return {
    pass: true,
    score: matched ? 1 : 0,
    reason: matched ? 'observable outcome matched' : `observable outcome did not ${matchMode}: ${expected.join(', ')}`
  }
}

export default outcome

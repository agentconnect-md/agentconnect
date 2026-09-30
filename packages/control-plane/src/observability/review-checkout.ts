import { metrics } from '@opentelemetry/api'
import type { ReviewCheckout } from '@agentconnect.md/protocol'

/** Whether the reporting daemon is an install-wide pool member or bound to one organization. */
export type ReviewCheckoutDaemonScope = 'install' | 'org'

interface CounterInstrument {
  add(value: number, attributes?: Record<string, string>): void
}

const meter = metrics.getMeter('@agentconnect.md/control-plane-review', '1.0.0')

const defaultCounter: CounterInstrument = meter.createCounter('agentconnect.review.checkout', {
  unit: '{review}',
  description: 'Formal code reviews by how their workspace was prepared: exact checkout or degraded, by reason'
})

/** Count one formal review's checkout outcome; labels are fixed enums, never ids. */
export function createReviewCheckoutMetric(counter: CounterInstrument = defaultCounter) {
  return (checkout: ReviewCheckout, scope: ReviewCheckoutDaemonScope): void => {
    try {
      counter.add(1, {
        outcome: checkout.outcome,
        reason: checkout.outcome === 'degraded' ? checkout.reason : 'none',
        daemon_scope: scope
      })
    } catch {
      // A metrics exporter never decides whether the start barrier is acknowledged.
    }
  }
}

export const countReviewCheckout = createReviewCheckoutMetric()

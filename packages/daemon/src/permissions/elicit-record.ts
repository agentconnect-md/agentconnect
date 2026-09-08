// One elicitation card's REDUCED payload — the shape the webchat stream sends live and the
// transcript row persists (#1794), built once so the two can never describe one card differently.

import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import type { ElicitBody, ElicitCard, ElicitField, ElicitOutcome } from '@agentconnect.md/protocol'
import type { ElicitTarget } from '../slack/render.js'
import { elicitFieldLabel, elicitRequiredProps } from '../slack/render.js'

/** The card-side descriptors of ONE field — the wire's own shape, minus what only a form
 *  entry names (property, label, kind, requiredness). */
type ElicitCardDescriptors = Pick<ElicitField, 'options' | 'multi' | 'text' | 'number' | 'defaultValue'>

/** The per-kind descriptors an elicitation card carries for one field: its options plus
 *  whichever constraint block its kind brings. Shared by the single-field card and each entry
 *  of a form, so a one-field form's payload stays exactly the single-field card's. Pure. */
export function elicitCardDescriptors(t: ElicitTarget): ElicitCardDescriptors {
  return {
    options: t.options,
    // Present only for a multi-select: it is what tells the card to offer toggles and a
    // confirm rather than one-tap buttons, and the bounds the confirm enforces.
    ...(t.kind === 'multi-enum'
      ? {
          multi: {
            ...(t.minItems !== undefined ? { minItems: t.minItems } : {}),
            ...(t.maxItems !== undefined ? { maxItems: t.maxItems } : {})
          }
        }
      : {}),
    // Present only for a typed field, and likewise what makes the card an input rather than a
    // row of options. The constraints ride along so the control can refuse an answer the
    // daemon would reject anyway.
    ...(t.kind === 'text'
      ? {
          text: {
            ...(t.minLength !== undefined ? { minLength: t.minLength } : {}),
            ...(t.maxLength !== undefined ? { maxLength: t.maxLength } : {}),
            ...(t.pattern !== undefined ? { pattern: t.pattern } : {}),
            ...(t.format !== undefined ? { format: t.format } : {})
          }
        }
      : {}),
    ...(t.kind === 'number'
      ? {
          number: {
            ...(t.integer ? { integer: true } : {}),
            ...(t.minimum !== undefined ? { minimum: t.minimum } : {}),
            ...(t.maximum !== undefined ? { maximum: t.maximum } : {})
          }
        }
      : {}),
    ...(t.defaultValue !== undefined ? { defaultValue: t.defaultValue } : {})
  }
}

/**
 * The payload for ONE form-mode card: its question plus what it offered. A multi-field form
 * carries its fields as a LIST and none of the single-field descriptors, exactly as the live
 * webchat event does — a reader that does not know `fields` then gets an optionless card it can
 * only dismiss, rather than one it could half-fill with an answer the daemon would refuse.
 *
 * `form` is the surface's OWN reduction, so a persisted Slack card describes what Slack offered
 * and a persisted webchat card what webchat did. Pure.
 */
export function elicitCardPayload(
  requestId: string,
  message: string,
  params: CreateElicitationRequest,
  form: readonly ElicitTarget[]
): ElicitCard {
  const required = new Set(elicitRequiredProps(params))
  const target = form[0]!
  return {
    requestId,
    message,
    ...(form.length > 1
      ? {
          options: [],
          fields: form.map((t) => ({
            propName: t.propName,
            label: elicitFieldLabel(params, t.propName),
            kind: t.kind,
            ...(required.has(t.propName) ? { required: true } : {}),
            ...(t.description ? { description: t.description } : {}),
            ...(t.customAnswerFor ? { customAnswerFor: t.customAnswerFor } : {}),
            ...elicitCardDescriptors(t)
          }))
        }
      : elicitCardDescriptors(target))
  }
}

/** The payload for a URL-mode CONSENT card. No options and no field descriptors: a reader that
 *  does not know `url` gets a card it can only Dismiss, which is the spec's `decline` and never
 *  an accidental consent. Pure. */
export function elicitUrlCardPayload(requestId: string, message: string, url: string): ElicitCard {
  return { requestId, message, options: [], url }
}

/** The payload for an ask no surface had a control for. It offers nothing, because nothing was
 *  offered — the row exists so a later reader still learns the question was asked, which the
 *  live-only decline notice (#1839) could not tell them. Pure. */
export function elicitUnrenderablePayload(requestId: string, message: string): ElicitCard {
  return { requestId, message, options: [] }
}

/** The card plus how it ended — what one `elicit` transcript row's `body` holds. The answer is
 *  named by its LABEL and never by the accepted content: the values are already in the agent's
 *  own context, and a label is what a reader coming back to the thread needs. Pure. */
export function elicitRowBody(card: ElicitCard, settled?: { outcome: ElicitOutcome; answerLabel?: string }): string {
  const body: ElicitBody = {
    ...card,
    ...(settled ? { outcome: settled.outcome } : {}),
    ...(settled?.answerLabel !== undefined ? { answerLabel: settled.answerLabel } : {})
  }
  return JSON.stringify(body)
}

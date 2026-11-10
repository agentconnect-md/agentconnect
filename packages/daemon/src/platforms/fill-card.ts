// The Fill card facet (computer-form-fill-and-vault.md §6): a chat surface posts a link to the console form, never a field.
import type { ComputerFillCardOutcome } from '@agentconnect.md/protocol/computer-form-fill'
import type { ElicitCardHost, ElicitCardTurn } from './elicit-card.js'

/** What a chat card says: who asks, for which website and how many fields, and where to fill them in. */
export interface FillCardModel {
  requestId: string
  agentName: string
  computerName: string
  origin: string
  fieldCount: number
  reason?: string
  /** The console session page that opens the card for the person who asked. */
  link: string
}

/** A posted card, so its settlement can rewrite it in place. */
export interface FillCardHandle {
  conn: unknown
  channel: string
  thread?: string
  ts: string
}

export interface FillCardFacet {
  readonly platform: string
  build(model: FillCardModel): unknown
  settled(model: FillCardModel, outcome: ComputerFillCardOutcome): unknown
  /** Post into the turn's own conversation on its apply chain; the message id, or undefined when refused. */
  send(host: ElicitCardHost, turn: ElicitCardTurn, draft: unknown): Promise<string | undefined>
  /** Edit the card in place; false when the platform refused. */
  rewrite(handle: FillCardHandle, draft: unknown): Promise<boolean>
}

/** A settled card's line; it never names a value. */
export function fillSettledText(model: Pick<FillCardModel, 'origin'>, outcome: ComputerFillCardOutcome): string {
  const site = model.origin
  switch (outcome) {
    case 'filled':
      return `Filled the form on ${site}.`
    case 'partial':
      return `Partly filled the form on ${site}.`
    case 'cancelled':
      return `The form on ${site} was not filled: cancelled.`
    case 'expired':
      return `The form on ${site} was not filled: the request expired.`
    case 'uncertain':
      return `It is unclear whether the form on ${site} was filled.`
    case 'target_changed':
      return `The page on ${site} changed before filling; nothing was written.`
    default:
      return `The form on ${site} could not be filled.`
  }
}

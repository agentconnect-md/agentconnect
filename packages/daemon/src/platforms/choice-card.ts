// The choice-card facet of Layer 2 (choice-cards.md): how a chat surface shows a card whose first permitted press starts a turn.

/** The edit choice's id, distinct from any option id a caller may pick. */
export const EDIT_CHOICE = '__edit__'

export interface ChoiceCardOption {
  readonly id: string
  readonly label: string
}

/** One card as core hands it to a surface; every text field is plain text each surface defuses itself. */
export interface ChoiceCardModel {
  readonly cardId: string
  readonly channel: string
  /** The thread the card sits in; absent ⇒ post it at top level. */
  readonly thread?: string
  /** The posted card's message id; empty before it is posted. */
  readonly ts: string
  readonly title: string
  readonly body: string
  readonly options: readonly ChoiceCardOption[]
  /** The editable text's starting value; null ⇒ no Send edited. */
  readonly editText: string | null
  /** `open` takes presses; `deciding` is a press being handed to the agent; anything else is settled. */
  readonly state: string
  readonly label: string | null
  readonly choice: string | null
  readonly clickedBy: string | null
  readonly editedText: string | null
}

/** One chat surface's choice-card facet; absent ⇒ the platform shows no choice cards. */
export interface ChoiceCardFacet {
  readonly platform: string
  /** Whether a press on a card posted through this connection reaches the daemon; a send-only connection declines. */
  serves(conn: unknown): boolean
  /** Post the card; its message id, or undefined when refused. */
  post(conn: unknown, card: ChoiceCardModel): Promise<string | undefined>
  /** Redraw a posted card for its current state. */
  redraw(conn: unknown, card: ChoiceCardModel): Promise<boolean>
  /** Tell only `userId`, beside the card, why their press was not taken; absent ⇒ the ingress says it. */
  tellPrivately?(
    conn: unknown,
    place: { channel: string; thread?: string },
    userId: string,
    text: string
  ): Promise<void>
}

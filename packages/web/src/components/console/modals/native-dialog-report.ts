/**
 * How a native MCP card's dialog hands a FAILED submit back to the conversation.
 *
 * A save already reports itself; a refusal has to report too, or the caller waits on something that
 * was never made. The report closes the dialog because one card reports ONCE — the daemon settles a
 * card on the message it sends, so a retry behind a settled card could never reach the caller. The
 * model still holds what it proposed and opens a corrected card, which is where a retry belongs.
 */
export function nativeFailureReport(
  /** What was attempted, as the sentence's subject — "Creating the agent", "Adding the integration". */
  what: string,
  onCompleted: (summary: string) => void,
  onClose: () => void
): (reason: string) => void {
  return (reason) => {
    onCompleted(`${what} failed: ${reason.slice(0, 300)}`)
    onClose()
  }
}

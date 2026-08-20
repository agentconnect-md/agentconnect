/**
 * Slack's **credentialed attachment read**, as an agent-facing tool (§7.1 read
 * port, stage S3).
 *
 * A Slack `url_private` is only fetchable with the bot token, which the agent
 * never holds — so the platform contributes a tool that downloads through its
 * own connection. Core injects it because Slack DECLARES it in
 * `platforms/read-ports.ts`, not because core knows the word "slack".
 *
 * THE NAME IS FROZEN. `readSlackFile` is what agents have learned, what every
 * shared resource_link points at, and what warm ACP sessions already carry in
 * their descriptor list. The injection mechanism generalized; the name did not.
 */
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export const SLACK_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readSlackFile',
  description:
    'Fetch the contents of a file shared in Slack, using the bot credentials. You do NOT have direct network access ' +
    "to Slack's private file URLs (they require the bot token) — use this tool instead of curl/fetch. Pass the file's " +
    '`url` (the `url_private` / `uri` from a shared attachment or resource link). Images are returned as viewable image ' +
    'content; text files as text. Supply `mimeType` when known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "The file's url_private (or url_private_download) / resource-link uri." },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. image/png or text/plain.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

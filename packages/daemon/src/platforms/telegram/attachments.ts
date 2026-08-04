/**
 * Telegram's **credentialed attachment read**, as an agent-facing tool (§7.1
 * read port, stage S3).
 *
 * A Telegram `file_id` is not a URL at all — resolving it to bytes needs a
 * `getFile` call with the bot token — so the platform contributes a tool that
 * downloads through its own connection. Core injects it because Telegram
 * DECLARES it in `platforms/read-ports.ts`, not because core knows the word
 * "telegram".
 *
 * THE NAME IS FROZEN — see the note on Slack's sibling module.
 */
import type { ToolDescriptor } from '../../mcp/tools.js'

export const TELEGRAM_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readTelegramFile',
  description:
    'Fetch the contents of a file shared in Telegram, using the bot credentials. You do NOT have direct network ' +
    "access to Telegram's file storage — use this tool instead of curl/fetch. Pass the file's `url` (the `file_id` " +
    'from a shared attachment or the `uri` of a resource link). Images are returned as viewable image content; text ' +
    'files as text. Supply `mimeType` when known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "The shared file's Telegram file_id (or resource-link uri)." },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. image/png or text/plain.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

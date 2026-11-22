// Google Chat's credentialed attachment read as an agent tool (google-chat-integration.md §5): an attachment name resolves to bytes only through the app's own credentials.
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export const GOOGLECHAT_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readGoogleChatFile',
  description:
    'Fetch the contents of a file uploaded in Google Chat, using the Chat app credentials. You do NOT have direct ' +
    'network access to Google Chat files — use this tool instead of curl/fetch. Pass the attachment `url` (its ' +
    'resource name, `spaces/…/messages/…/attachments/…`, from a shared attachment or resource link). Images are ' +
    'returned as viewable image content; text files as text. Any other file (PDF, spreadsheet, archive, …) is saved ' +
    'into your session uploads directory, outside the repository, and the result names the path — open it with ' +
    'your file tools. Google Drive files cannot be read. Supply `mimeType` when known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: "The attachment's Google Chat resource name, spaces/…/messages/…/attachments/…"
      },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. image/png or application/pdf.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

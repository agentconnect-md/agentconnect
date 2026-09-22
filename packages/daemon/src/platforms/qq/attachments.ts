import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

/** QQ attachment reads use the bot-bound connection so provider URLs never leave the daemon. */
export const QQ_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readQQFile',
  description:
    'Fetch a file shared in QQ through the current bot connection. Pass the attachment resource link `url`; do not ' +
    'try to access it directly; use this tool instead of curl/fetch. Images are returned as viewable image content ' +
    'and text files as text. Any other file (PDF, ' +
    'spreadsheet, archive, audio, video, …) is saved into `uploads/` in your workspace and the result names the path. ' +
    'Supply `mimeType` when known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "The shared file's attachment URL or resource-link uri." },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. application/pdf or audio/mpeg.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

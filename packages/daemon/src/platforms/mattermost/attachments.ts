// Mattermost's credentialed attachment read: a file ID or Mattermost file URL becomes bytes only through the connection that holds its bot token.
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export const MATTERMOST_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readMattermostFile',
  description:
    'Fetch an image or file shared in Mattermost through the current bot connection. Pass the attachment `url` ' +
    '(its Mattermost file URL or 26-character file ID, from the resource-link uri); Mattermost files require bot ' +
    'credentials, so use this tool instead of curl/fetch. Images are returned as viewable image content and text ' +
    'files as text. Any other file (PDF, spreadsheet, archive, …) is saved into your session uploads directory, ' +
    'outside the repository, and the result names the path. Supply `mimeType` when known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "The shared file's Mattermost file URL or file ID." },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. application/pdf or image/png.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

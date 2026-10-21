// DingTalk's credentialed attachment read: a download code becomes bytes only through the app's own token (dingtalk-integration.md §4.5).
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export const DINGTALK_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readDingTalkFile',
  description:
    'Fetch a file or image shared in DingTalk through the current bot connection. Pass the attachment `url` (its ' +
    'download code, the `uri` of a resource link); it is not a web address, so use this tool instead of curl/fetch. ' +
    'Images are returned as viewable image content and text files as text. Any other file (PDF, spreadsheet, ' +
    'archive, …) is saved into `uploads/` in your workspace and the result names the path. Supply `mimeType` when ' +
    'known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "The shared file's download code (the resource-link uri)." },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. application/pdf or image/png.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

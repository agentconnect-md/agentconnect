// WeChat's credentialed attachment read: a media reference becomes bytes only through the connection that received its key (wechat-integration.md §4.6).
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'

export const WECHAT_ATTACHMENT_TOOL: ToolDescriptor = {
  name: 'readWeChatFile',
  description:
    'Fetch an image, file or video shared in WeChat through the current bot connection. Pass the attachment `url` ' +
    '(its `wechat-media:` reference, the `uri` of a resource link); it is not a web address, so use this tool ' +
    'instead of curl/fetch. Images are returned as viewable image content and text files as text. Any other file ' +
    '(PDF, spreadsheet, archive, …) is saved into `uploads/` in your workspace and the result names the path. ' +
    'Supply `mimeType` when known for correct handling.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: "The shared file's `wechat-media:` reference (the resource-link uri)." },
      mimeType: { type: 'string', description: 'Optional MIME type hint, e.g. application/pdf or image/png.' }
    },
    required: ['url'],
    additionalProperties: false
  }
}

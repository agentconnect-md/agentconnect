import { ToolResultContentType, type ToolResultFileEditContent } from '@microsoft/agent-host-protocol'
import type { ToolEdit } from '../session/tool-edits.js'

// VS Code serves `session-db:` content without a stat round trip, so snapshots need only `resourceRead`.
const scheme = 'session-db:'
const hex = (value: string) => Buffer.from(value, 'utf8').toString('hex')
const unhex = (value: string) => (/^(?:[0-9a-f]{2})+$/.test(value) ? Buffer.from(value, 'hex').toString('utf8') : '')

export type FileEditSide = 'before' | 'after'
export interface FileEditRef {
  sessionUri: string
  toolCallId: string
  index: number
  path: string
  side: FileEditSide
}

export function fileEditUri(ref: FileEditRef): string {
  const name = ref.path.split('/').filter(Boolean).at(-1) ?? 'file'
  return `${scheme}//${hex(ref.sessionUri)}/${hex(ref.toolCallId)}/${ref.index}/${hex(ref.path)}/${ref.side}/${encodeURIComponent(name)}`
}

export function parseFileEditUri(uri: string): FileEditRef | undefined {
  if (!uri.startsWith(`${scheme}//`)) return
  const [authority, toolCallId, index, path, side, name, ...rest] = uri.slice(scheme.length + 2).split('/')
  if (rest.length || !name || !/^(?:0|[1-9]\d?)$/.test(index ?? '') || (side !== 'before' && side !== 'after')) return
  const ref: FileEditRef = {
    sessionUri: unhex(authority!),
    toolCallId: unhex(toolCallId!),
    index: Number(index),
    path: unhex(path!),
    side
  }
  return ref.sessionUri && ref.toolCallId && ref.path ? ref : undefined
}

export function fileEditContent(sessionUri: string, toolCallId: string, edit: ToolEdit): ToolResultFileEditContent {
  const file = `file://${edit.path.startsWith('/') ? '' : '/'}${edit.path.split('/').map(encodeURIComponent).join('/')}`
  const side = (name: FileEditSide, sizeHint: number) => ({
    uri: file,
    content: {
      uri: fileEditUri({ sessionUri, toolCallId, index: edit.index, path: edit.path, side: name }),
      sizeHint,
      contentType: 'text/plain'
    }
  })
  return {
    type: ToolResultContentType.FileEdit,
    ...(edit.created ? {} : { before: side('before', edit.beforeBytes ?? 0) }),
    after: side('after', edit.afterBytes),
    diff: { added: edit.added, removed: edit.removed }
  }
}

import { sniffSharedImage } from '../../images/sniff.js'

/** What `shareFile` posts a workspace file as (agent-authored-attachments.md §4). */
export type SharedFileKind =
  /** PNG, JPEG, WEBP or GIF by magic bytes: posted as an inline picture (a GIF as an animation), named and typed from those bytes. */
  | { kind: 'image'; name: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' }
  /** Anything else: posted as a downloadable file under the path's own name, typed from its extension. */
  | { kind: 'document'; name: string; mimeType: string }

/** The type a shared document is labelled with, by extension. HTML, SVG and scripts stay opaque, as the
 *  console's workspace download labels them: a shared file is for saving, never for a browser to run. */
const DOCUMENT_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus'
}

export function documentMimeType(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase()
  return (ext && DOCUMENT_MIME_TYPES[ext]) || 'application/octet-stream'
}

const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

/**
 * Decide how a workspace file posts. An image is recognised by its bytes and renamed to match
 * them — Discord renders by extension alone, so `out/chart` must become `chart.png`. A document
 * keeps the path's own file name (control characters dropped): there is no byte signature to
 * derive one from, and the name is what the recipient saves it as.
 */
export function sharedFileKind(rel: string, bytes: Buffer): SharedFileKind {
  const sniffed = sniffSharedImage(bytes)
  const base =
    rel
      .split(/[\\/]/)
      .pop()
      ?.replace(/[\u0000-\u001f\u007f]/g, '') || 'file'
  if (sniffed && sniffed !== 'image/svg+xml') {
    const stem = base.replace(/\.[A-Za-z0-9]+$/, '') || 'image'
    return { kind: 'image', name: `${stem}.${IMAGE_EXTENSIONS[sniffed]}`, mimeType: sniffed }
  }
  return { kind: 'document', name: base, mimeType: documentMimeType(base) }
}

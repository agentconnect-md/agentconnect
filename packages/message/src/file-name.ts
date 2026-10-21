const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4'
}

// The MIME type a platform that sends only a file name implies by its extension; unknown ones stay opaque bytes.
export function mimeTypeFromFileName(filename?: string): string {
  const ext = filename?.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined
  return (ext && Object.hasOwn(MIME_BY_EXTENSION, ext) && MIME_BY_EXTENSION[ext]) || 'application/octet-stream'
}

// A provider file name made safe to show and store: no path separators, control characters or parentheses, bounded.
export function safeAttachmentName(name?: string): string | undefined {
  return name?.replace(/[\\/\x00-\x1f\x7f()]/g, '_').slice(0, 160) || undefined
}

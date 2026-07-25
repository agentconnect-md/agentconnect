import type { SessionImage } from '@/lib/data'

// The relay/daemon wire allows 160 KiB of decoded image bytes. Keeping the
// browser target identical leaves enough room for base64 expansion and the
// surrounding rd/msg envelope under the protocol's 256 KiB frame ceiling.
export const WEBCHAT_IMAGE_MAX_BYTES = 160 * 1024
const WEBCHAT_IMAGE_MAX_SOURCE_BYTES = 20 * 1024 * 1024
const WEBCHAT_IMAGE_MAX_EDGE = 1600

/** Read the first pasted image without intercepting ordinary text paste. */
export function clipboardImageFile(data: Pick<DataTransfer, 'items' | 'files'>): File | undefined {
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) return file
  }
  return Array.from(data.files).find((file) => file.type.startsWith('image/'))
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode this image.'))),
      'image/webp',
      quality
    )
  })
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read this image.'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      if (comma < 0) reject(new Error('Could not read this image.'))
      else resolve(result.slice(comma + 1))
    }
    reader.readAsDataURL(blob)
  })
}

function webpName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  const dot = clean.lastIndexOf('.')
  const stem = (dot > 0 ? clean.slice(0, dot) : clean).trim().slice(0, 245) || 'image'
  return `${stem}.webp`
}

/** Rasterize a browser-readable image into one bounded WebP attachment. */
export async function prepareWebchatImage(file: File): Promise<SessionImage> {
  if (file.size > WEBCHAT_IMAGE_MAX_SOURCE_BYTES) {
    throw new Error('Choose an image smaller than 20 MB.')
  }
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error('Choose an image file.')
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('Couldn’t read that image. Try PNG, JPEG, or WebP.')
  }

  try {
    const sourceEdge = Math.max(bitmap.width, bitmap.height)
    let scale = sourceEdge > WEBCHAT_IMAGE_MAX_EDGE ? WEBCHAT_IMAGE_MAX_EDGE / sourceEdge : 1
    let quality = 0.86
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Couldn’t prepare that image.')

    for (let attempt = 0; attempt < 10; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

      const blob = await canvasBlob(canvas, quality)
      if (blob.size <= WEBCHAT_IMAGE_MAX_BYTES) {
        return {
          name: webpName(file.name),
          mimeType: 'image/webp',
          data: await blobBase64(blob)
        }
      }

      if (quality > 0.5) {
        quality = Math.max(0.5, quality - 0.12)
      } else {
        const shrink = Math.max(0.5, Math.min(0.88, Math.sqrt(WEBCHAT_IMAGE_MAX_BYTES / blob.size) * 0.92))
        scale *= shrink
      }
    }
  } finally {
    bitmap.close()
  }

  throw new Error('Couldn’t make that image small enough to send.')
}

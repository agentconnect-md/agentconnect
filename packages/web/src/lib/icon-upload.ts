// Client-side icon normalization (docs/designs/icon-uploads.md): crop the picked
// file to a centered square and resize to <=256x256, then encode PNG. Doing this in
// the browser means the CP never needs a raster decoder (sharp) — it just sniffs +
// stores the bytes. Browser-only (uses <canvas>); call from event handlers, not SSR.

const ICON_SIZE = 256

/** Resize/crop `file` to a 256x256 PNG blob for upload. Throws on decode failure. */
export async function resizeImageToIconBlob(file: File, size = ICON_SIZE): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    // Center-crop the largest square, then scale it to the target.
    const s = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - s) / 2
    const sy = (bitmap.height - s) / 2
    ctx.drawImage(bitmap, sx, sy, s, s, 0, 0, size, size)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png')
    )
  } finally {
    bitmap.close()
  }
}

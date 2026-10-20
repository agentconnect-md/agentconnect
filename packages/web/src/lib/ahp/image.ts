import type { SessionImage } from '@/lib/data'
import { prepareWebchatImage } from '@/lib/webchat-image'
export async function fitAhpImage(image: SessionImage, budget: number): Promise<SessionImage> {
  if (image.data.length <= Math.floor(budget / 3) * 4) return image
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0))
  return prepareWebchatImage(new File([bytes], image.name, { type: image.mimeType }), budget)
}

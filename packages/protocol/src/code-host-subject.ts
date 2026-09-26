export const CODE_HOST_SUBJECT_MAX_BYTES = 8 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
const omission = '\n\n[... content omitted ...]\n\n'

// Keep both ends of the event's description, including closing attribution, within the UTF-8 budget.
export function codeHostSubjectBody(
  text: string,
  maxBytes = CODE_HOST_SUBJECT_MAX_BYTES
): { body: string; bodyTruncated: boolean } {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return { body: text, bodyTruncated: false }
  if (maxBytes <= omission.length) return { body: '', bodyTruncated: true }
  const available = maxBytes - omission.length
  const headBudget = Math.floor(available / 2)
  let head = headBudget
  let tail = bytes.length - (available - headBudget)
  while ((bytes[head]! & 0xc0) === 0x80) head--
  while ((bytes[tail]! & 0xc0) === 0x80) tail++
  return {
    body: decoder.decode(bytes.subarray(0, head)) + omission + decoder.decode(bytes.subarray(tail)),
    bodyTruncated: true
  }
}

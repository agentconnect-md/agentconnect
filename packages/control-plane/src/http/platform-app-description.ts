export const DEFAULT_PLATFORM_APP_DESCRIPTION = 'AI agent powered by AgentConnect.'
export const PLATFORM_APP_DESCRIPTION_MAX_CHARACTERS = 100
export const LARK_APP_DESCRIPTION_MAX_LENGTH = 120
export const SLACK_APP_DESCRIPTION_MAX_BYTES = 300

const ELLIPSIS = '…'
const UTF8_ENCODER = new TextEncoder()
const utf16Length = (value: string): number => value.length
const codePointLength = (value: string): number => [...value].length

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength
}

/** Keep a description concise and within its platform-specific measured limit
 * without splitting a Unicode code point. Lark uses the default UTF-16 length;
 * Slack's live manifest validator applies its 300-character limit to UTF-8 bytes. */
export function platformAppDescription(
  description: string | null | undefined,
  maxLength: number,
  lengthOf: (value: string) => number = utf16Length
): string {
  const value = description?.trim() || DEFAULT_PLATFORM_APP_DESCRIPTION
  if (codePointLength(value) <= PLATFORM_APP_DESCRIPTION_MAX_CHARACTERS && lengthOf(value) <= maxLength) return value

  let head = ''
  let length = lengthOf(ELLIPSIS)
  let characters = 1
  for (const character of value) {
    const measuredLength = lengthOf(character)
    if (characters + 1 > PLATFORM_APP_DESCRIPTION_MAX_CHARACTERS || length + measuredLength > maxLength) break
    head += character
    length += measuredLength
    characters += 1
  }
  return `${head.trimEnd()}${ELLIPSIS}`
}

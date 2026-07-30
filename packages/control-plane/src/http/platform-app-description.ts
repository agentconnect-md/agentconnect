export const DEFAULT_PLATFORM_APP_DESCRIPTION = 'AI agent powered by AgentConnect.'
export const LARK_APP_DESCRIPTION_MAX_LENGTH = 120
export const SLACK_APP_DESCRIPTION_MAX_LENGTH = 300

/**
 * Platform launchers count JavaScript string length, so keep the result within
 * their UTF-16 limit without cutting a surrogate pair in half.
 */
export function platformAppDescription(description: string | null | undefined, maxLength: number): string {
  const value = description?.trim() || DEFAULT_PLATFORM_APP_DESCRIPTION
  if (value.length <= maxLength) return value

  let head = ''
  for (const character of value) {
    if (head.length + character.length >= maxLength) break
    head += character
  }
  return `${head.trimEnd()}…`
}

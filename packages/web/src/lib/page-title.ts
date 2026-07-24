import type { Metadata } from 'next'

const PRODUCT_NAME = 'AgentConnect'

/**
 * Adds an optional deployment label to browser-tab titles. The plain env var is
 * read at request time, while the NEXT_PUBLIC_ form remains useful in local dev.
 */
export function pageTitleMetadata(
  environment = process.env.WEB_TITLE_ENV ?? process.env.NEXT_PUBLIC_WEB_TITLE_ENV
): Metadata {
  const label = environment?.trim()

  if (!label) return { title: PRODUCT_NAME }

  return {
    title: {
      default: `(${label}) ${PRODUCT_NAME}`,
      template: `(${label}) %s`
    }
  }
}

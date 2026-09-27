// No 'use client' here: rendered only by `MessageText`, which is the client boundary.

import { lazy, Suspense } from 'react'

// Lazy so the Markdown pipeline stays out of the registry, which every console route imports (registry.ts `platformTextRenderer`).
const GoogleChatMarkdownText = lazy(() => import('./text'))

/** Google Chat's transcript renderer ({@link WebPlatformModule.textRenderer}); plain text shows until the parser loads. */
export function GoogleChatText({ text }: { text: string }) {
  return (
    <Suspense
      fallback={
        <div className="mdtxt">
          <p className="whitespace-pre-wrap">{text}</p>
        </div>
      }
    >
      <GoogleChatMarkdownText text={text} />
    </Suspense>
  )
}

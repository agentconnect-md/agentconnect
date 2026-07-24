import type { Metadata } from 'next'
import './globals.css'
import { Analytics } from '@/components/Analytics'
import { BrowserTelemetry } from '@/components/BrowserTelemetry'
import { pageTitleMetadata } from '@/lib/page-title'
import { PublicEnvScript } from '@/lib/public-env'

export function generateMetadata(): Metadata {
  return {
    ...pageTitleMetadata(),
    description: 'Multi-agent platform bridging IM platforms to AI coding agents'
  }
}

// Render per-request so PublicEnvScript reflects the container's runtime env
// (not whatever was set when the image was built).
export const dynamic = 'force-dynamic'

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // The (app) layout's theme-init script sets `data-theme` on <html> before
    // hydration, so this attribute intentionally differs from the SSR output —
    // suppress React's (one-level) hydration warning for it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <PublicEnvScript />
      </head>
      <body>
        <Analytics />
        <BrowserTelemetry />
        {children}
      </body>
    </html>
  )
}

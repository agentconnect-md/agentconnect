import type { Metadata } from 'next'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import './globals.css'
import { Analytics } from '@/components/Analytics'
import { BrowserTelemetry } from '@/components/BrowserTelemetry'
import { LOCALES, type Locale } from '@/i18n/config'
import { pageTitleMetadata } from '@/lib/page-title'
import { PublicEnvScript } from '@/lib/public-env'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Common.metadata')
  return {
    ...pageTitleMetadata(),
    description: t('description')
  }
}

// Render per request so runtime environment and locale preferences stay current.
export const dynamic = 'force-dynamic'

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = (await getLocale()) as Locale
  const messages = await getMessages()
  const meta = LOCALES[locale]

  return (
    // The app layout sets data-theme before hydration, so this attribute intentionally differs from SSR.
    <html lang={meta.htmlLang} dir={meta.dir} suppressHydrationWarning>
      <head>
        <PublicEnvScript />
      </head>
      <body>
        <NextIntlClientProvider messages={messages}>
          <Analytics />
          <BrowserTelemetry />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  )
}

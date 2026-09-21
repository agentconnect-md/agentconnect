import english from '../messages/en.json'

declare module 'next-intl' {
  interface AppConfig {
    Locale: keyof typeof import('./i18n/config').LOCALES
    Messages: typeof english
  }
}

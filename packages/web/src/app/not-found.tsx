import { NotFound } from '@/components/console/NotFound'
import { useTranslations } from 'next-intl'

// Global fallback for any path that matches no route — including a bare unknown
// first segment like `/xxx` (the org-slug position), which the in-shell
// `[slug]/[...notFound]` catch-all can't reach. Rendered by the root layout, so
// there's no shell/org context: no rail, and global search isn't mounted (hence
// `showSearch={false}`). "Go home" heads to `/`, which resolves to the active
// org's Home.
export default function NotFoundPage() {
  const t = useTranslations('Common.notFound')
  return (
    <div className="flex min-h-screen items-center justify-center bg-(--surface-app) p-6">
      <div className="w-full max-w-[460px]">
        <NotFound
          icon="compass"
          kind="PAGE"
          title={t('pageTitle')}
          post={t('pageDescription')}
          actionLabel={t('goHome')}
          actionHref="/"
          showSearch={false}
        />
      </div>
    </div>
  )
}

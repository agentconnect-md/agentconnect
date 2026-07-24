import { NotFound } from '@/components/console/NotFound'

// Global fallback for any path that matches no route — including a bare unknown
// first segment like `/xxx` (the org-slug position), which the in-shell
// `[slug]/[...notFound]` catch-all can't reach. Rendered by the root layout, so
// there's no shell/org context: no rail, and global search isn't mounted (hence
// `showSearch={false}`). "Go to agents" heads to `/`, which resolves to the
// active org's agents list.
export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-(--surface-app) p-6">
      <div className="w-full max-w-[460px]">
        <NotFound
          icon="compass"
          kind="PAGE"
          title="Page not found"
          post="This page doesn’t exist. Check the address, or head back to your agents."
          actionLabel="Go to agents"
          actionHref="/"
          showSearch={false}
        />
      </div>
    </div>
  )
}

import { redirect } from 'next/navigation'

// Cloud computers are listed on the Infra page now; keep old links landing on them.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  redirect(`/${encodeURIComponent(slug)}/daemons#cloud-computers`)
}

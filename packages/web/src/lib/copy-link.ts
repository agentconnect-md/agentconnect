export async function copyLink(link: string, label: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(link)
    return true
  } catch {
    window.prompt(label, link)
    return false
  }
}

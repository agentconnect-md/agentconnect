/** A rule's label filter against a subject's CURRENT labels: empty or absent admits everything, otherwise at
 *  least one label must be in the filter. Case-insensitive — GitHub label names are unique without regard to
 *  case, and a console-typed filter should not have to reproduce a repository's casing on any host. */
export function labelFilterAdmits(filter: readonly string[] | undefined, labels: readonly string[]): boolean {
  if (!filter || filter.length === 0) return true
  const wanted = new Set(filter.map((label) => label.toLowerCase()))
  return labels.some((label) => wanted.has(label.toLowerCase()))
}

'use client'

// How a team row prints its name ({@link WebChannelListSemantics.RowName}, §4.5): the team's
// NAME, which opens the team in Linear, then its KEY in muted text. The key is an identifier
// rather than a label, so it never entered the stored `<Workspace> / <Team>` string (§4.5) and
// is not parsed back out of one — it rides the row as its own field, and so does the link.
// Only the name is the anchor: the key sits beside it as plain text, so a reader can copy the
// identifier without arming a navigation.

export function LinearTeamName({ name, channelKey, url }: { name: string; channelKey?: string; url?: string }) {
  return (
    <>
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${name} in Linear`}
          // The row's own type and color, not a link's: this is the row's label, which happens
          // to lead somewhere. The console's inline links read the same way (`GitlabCard`).
          className="min-w-0 truncate text-inherit no-underline hover:underline"
        >
          {name}
        </a>
      ) : (
        // A workspace whose URL segment is not known yet still prints its name and its key.
        <span className="min-w-0 truncate">{name}</span>
      )}
      {channelKey && <span className="mono flex-none text-(--text-tertiary)">{channelKey}</span>}
    </>
  )
}

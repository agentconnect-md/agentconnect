# Skills and MCP servers — only when the user asks

**Read the heading again.** A freshly created agent already works with its runtime's
own tools. Adding a skill or an MCP server is an answer to something the user said —
"it should follow our review checklist", "give it access to our Postgres MCP",
"install the terraform skill" — and never a step you volunteer in an ordinary creation.
Do not offer it, do not list it under "next steps", do not open its dialog to be
helpful. A template whose agent genuinely needs one says so in its own spec.

When the user _did_ ask, this is the whole surface.

## Adding

| Tool               | Opens                                                             | Arguments                                                   |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `installSkill`     | the skill installer — skills.sh registry search, or a Git import  | `source`: `registry` (default) \| `git`; `query`; `agentId` |
| `installMcpServer` | "Add MCP server" — name, url, header or OAuth credential, sharing | `agentId`                                                   |

Pass the new `agentId` to both. Without it the dialog only adds to the organization's
library, and **a library entry gives no agent anything**: capabilities are registered
once at the org level and enabled per agent. With it, the dialog also enables the skill
or attaches the server on that agent — and reports that second write separately,
because it can fail on its own. Read the summary before you claim both landed.

`query` preseeds the registry search with a name the user gave; do not invent one, and
do not promise a registry skill exists before the search has run.

The credential rule is absolute here: an MCP server's header value, client secret or
authorization code is typed into the dialog, never into a tool argument and never into
chat. Both a transcript and an audit log would keep it.

## Showing and removing

`manageAgentTools` (`agentId`, optional `focus`: `mcp` \| `skills`) opens the agent's
Tools & Skills rosters — every attached MCP server and every enabled skill, each row
with its own add and remove control. This is the **only** way to disable a skill or
detach a server: the installers only add, and naming a row to remove in a tool argument
would mean guessing at rows you have never seen. Each row saves as it is toggled, and
the dialog reports the resulting counts when the user is done.

If the user asks what an agent already has, open the roster rather than describing it
from memory — `getAgent` does not enumerate enabled skills.

## After

Verify the same way as everywhere else: the dialog's summary says what it did, a read
says what the platform holds. Then go back to what the user was actually doing.

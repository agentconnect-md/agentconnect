# AgentConnect

AgentConnect connects people and agents through conversations. This glossary records
agreed domain terms as the product model is refined.

## Language

### Images in conversations

**Shared image**:
An image the agent has explicitly published into the current conversation as a
viewable preview. Original-file availability is independent of whether it is shared.
_Avoid_: Generated image (when referring to publication rather than creation)

**Original image**:
The complete image selected for sharing, before any reduction made for its chat
preview. Viewing or downloading the original refers to this version.
_Avoid_: Preview, current workspace version

**Image preview**:
The representation of a shared image displayed in the chat flow. It may be reduced
to fit the display limit and is distinct from the original image. A vector original
may have either a vector preview or a reduced raster rendering.
_Avoid_: Original image, thumbnail (when implying a fixed small dimension)

**Expired original**:
A previously available shared image's original that is no longer retained for
retrieval. Its preview remains part of the conversation.
_Avoid_: Expired link (a temporary access link can expire while the original remains available)

**Original delivery**:
The work that makes a shared image's original available for viewing and download.
It belongs to the shared image and can continue after the generating turn ends.
_Avoid_: Image generation, image publication

### Session collaboration

**Sub-session parent**:
The session that created and owns a background sub-session. This relationship
persists across messages and successive rounds of work.
_Avoid_: Most recent caller, origin (when referring specifically to ownership)

**Origin session**:
A source session from which another session has accepted a call or reply, and to
which that receiving session may reply. A shared session can have multiple origins;
being an origin does not make it the parent of a background sub-session.
_Avoid_: Sole caller, fixed parent (for a shared peer session)

**Reply obligation**:
The expectation that a particular accepted call will receive an outcome in its
source session. Replying to one source does not satisfy another source's request.
_Avoid_: Session ownership, broadcast subscription

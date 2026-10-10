---
name: agentconnect-images
description: Create an image with the tools this runtime actually has, save it in the workspace, and show it in the current AgentConnect conversation with the shareFile tool. Use when someone asks you to generate, draw, edit, plot or show an image, illustration, chart or diagram.
---

# Generating and sharing images

This skill is a workflow, not an image engine. You create the image with capabilities
your runtime already exposes; AgentConnect's `shareFile` tool then shows it to the
person you are talking to. If `shareFile` is not among your tools in this conversation,
describe the result in words instead.

## 1. Create the image

- **Illustrations, photos, edits:** use a native image-generation capability or an image
  tool that is already configured in this session. Check what you actually have; do not
  assume a tool exists because of your model or runtime name.
- **Charts and technical diagrams:** use the plotting or rendering tools available to you
  (for example a Python plotting library) when that fits the request. Produce PNG, JPEG,
  WEBP or a self-contained static SVG, and keep any editable source (script, notebook,
  `.drawio`, …) next to it.
- Never silently substitute a plotted diagram for a requested illustration. If the person
  asked for a generated picture and you cannot generate one, say so.

If no generation capability is available, explain which capability is missing. Do not
invent a tool name, install a provider, ask for new credentials on your own, or claim
that AgentConnect can call tools that only exist inside another runtime.

## 2. Save it in the workspace

- Save the finished original inside your workspace, preferably under
  `outputs/images/` with a unique, descriptive name such as
  `outputs/images/product-illustration-2.png`.
- A generator may hand you bytes, a temporary path or a download link. Use your file or
  network tools to put the result in the workspace first; a file outside the workspace
  cannot be shared.
- If you can inspect images, look at the result before sharing it.

## 3. Share it

Call `shareFile` with the workspace-root-relative path and an optional short caption:

```json
{ "path": "outputs/images/product-illustration.png", "caption": "Product illustration" }
```

- Your working directory may be a subdirectory; the path is always relative to the
  workspace root.
- One call shares one image. Several images need several calls.
- The result is a short receipt (`"type": "agentconnect.image"`, `"published": true`).
  The person already sees an image card with **View original** and **Download**.
- After a successful share, do not repeat the image as Markdown and do not paste download
  URLs into your reply. A reply that is only the image is fine; add text only when it
  helps.
- Static SVG is accepted only when it is self-contained: no scripts, event handlers,
  external references, entities or embedded HTML.

## When something fails

Generation failing and sharing failing are different outcomes:

- If generation failed, say what went wrong and stop.
- If `shareFile` refused the file (wrong type, too large, unsafe SVG, path outside the
  workspace), fix what the error names and try once more, or tell the person the image
  was created at its workspace path but could not be displayed.
- Never call `shareFile` again for an image that was already published — a later problem
  with the original's upload does not remove the card.

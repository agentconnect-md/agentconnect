// The browser tier's tools (computer-use.md §5.8): `computer-browser-v1`, the chrome_* names and schemas every daemon speaks.
import type { ComputerIsolation, ComputerPolicy } from './frames/computer.js'

/** The CP advertises it once its tokens and grants name the tier; the agent daemon offers the tools only under such a CP. */
export const COMPUTER_BROWSER_FEATURE = 'computer-browser-v1'

/** Every tool of the tier carries it; the rest of the name is Chrome DevTools MCP's own, as v1 took it from 1.13.0. */
export const COMPUTER_BROWSER_TOOL_PREFIX = 'chrome_'

/** One tool's JSON Schema: an object with no properties beyond those it names. */
export interface ComputerBrowserInputSchema {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties: false
}

export interface ComputerBrowserTool {
  name: string
  // Takes the desktop's control lease, as §5.8's table says (not the child's annotations).
  lease: boolean
  // Offered only while the command-line tier allows it: scripts follow `shell`, uploads follow `files` (§5.7).
  requires?: 'shell' | 'files'
  description: string
  inputSchema: ComputerBrowserInputSchema
}

// The child's schemas: names prefixed, page ids the desktop's opaque strings, file and script arguments removed.
export const COMPUTER_BROWSER_TOOLS: readonly ComputerBrowserTool[] = [
  {
    name: 'chrome_list_pages',
    lease: false,
    description: 'Get a list of pages open in the browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'chrome_take_snapshot',
    lease: false,
    description:
      'Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique\nidentifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected\nin the DevTools Elements panel (if any).',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        verbose: {
          description: 'Whether to include all possible information available in the full a11y tree. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_take_screenshot',
    lease: false,
    description: 'Take a screenshot of the page or element.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        format: {
          default: 'jpeg',
          description: 'Type of format to save the screenshot as. Default is "jpeg"',
          type: 'string',
          enum: ['png', 'jpeg', 'webp']
        },
        quality: {
          description:
            'Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.',
          type: 'number',
          minimum: 0,
          maximum: 100
        },
        uid: {
          description:
            'The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.',
          type: 'string'
        },
        fullPage: {
          description:
            'If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.',
          type: 'boolean'
        }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_wait_for',
    lease: false,
    description:
      'Wait for the specified text to appear on the selected page. By default, hidden text is also matched. Set visible to true to wait until the matched text is visible.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        text: {
          minItems: 1,
          type: 'array',
          items: { type: 'string' },
          description:
            'Non-empty list of texts. Resolves when any value matches an accessible name exactly or is a substring of DOM text. Matching is case-sensitive. DOM text preserves spaces and newlines, unlike snapshot text which may normalize whitespace. Use the original whitespace or a shorter distinctive substring.'
        },
        timeout: {
          description: 'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.',
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991
        },
        visible: {
          description: 'If true, wait until the matching text is visible. By default, hidden text also counts.',
          default: false,
          type: 'boolean'
        }
      },
      required: ['pageId', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_list_console_messages',
    lease: false,
    description: 'List all console messages for the target page since the last navigation.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        pageSize: {
          description: 'Maximum number of messages to return. When omitted, returns all messages.',
          type: 'integer',
          exclusiveMinimum: 0,
          maximum: 9007199254740991
        },
        pageIdx: {
          description:
            'Page number to return (0-based). When omitted, returns the first page. Ignored unless pageSize is set.',
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991
        },
        types: {
          description:
            'Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.',
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'log',
              'debug',
              'info',
              'error',
              'warn',
              'dir',
              'dirxml',
              'table',
              'trace',
              'clear',
              'startGroup',
              'startGroupCollapsed',
              'endGroup',
              'assert',
              'profile',
              'profileEnd',
              'count',
              'timeEnd',
              'verbose',
              'issue'
            ]
          }
        },
        includePreservedMessages: {
          description: 'Set to true to return the preserved messages over the last 3 navigations.',
          default: false,
          type: 'boolean'
        },
        includeStackTraces: {
          description:
            'Set to true to include the stack trace for each message when available. Increases the response size.',
          default: false,
          type: 'boolean'
        },
        serviceWorkerId: {
          description: 'Filter messages by the service worker ID shown by chrome_list_pages (sw-N).',
          type: 'string'
        }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_get_console_message',
    lease: false,
    description: 'Gets a console message by its ID. You can get all messages by calling chrome_list_console_messages.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        msgid: {
          type: 'number',
          description: 'The msgid of a console message on the page from the listed console messages'
        }
      },
      required: ['pageId', 'msgid'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_click',
    lease: true,
    description: 'Clicks on the provided element',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        uid: { type: 'string', description: 'The uid of an element on the page from the page content snapshot' },
        dblClick: { description: 'Set to true for double clicks. Default is false.', type: 'boolean' },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'uid'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_hover',
    lease: true,
    description: 'Hover over the provided element',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        uid: { type: 'string', description: 'The uid of an element on the page from the page content snapshot' },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'uid'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_drag',
    lease: true,
    description: 'Drag an element onto another element',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        from_uid: { type: 'string', description: 'The uid of the element to drag' },
        to_uid: { type: 'string', description: 'The uid of the element to drop into' },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'from_uid', 'to_uid'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_fill',
    lease: true,
    description: 'Type text into an input, text area or select an option from a <select> element.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        uid: { type: 'string', description: 'The uid of an element on the page from the page content snapshot' },
        value: {
          type: 'string',
          description: 'The value to fill in. "true" or "false" for checkboxes and toggles, "true" for radio buttons.'
        },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'uid', 'value'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_fill_form',
    lease: true,
    description:
      "Fill out multiple form elements (inputs, selects, checkboxes, radios) at once. ALWAYS prefer this tool over multiple individual 'fill' or 'click' calls when interacting with forms. It is significantly faster, more reliable, and reduces turn count. Example: Fill username, password, and check \"Remember Me\" in one call.",
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              uid: { type: 'string', description: 'The uid of the element to fill out' },
              value: {
                type: 'string',
                description:
                  'Value for the element. "true" or "false" for checkboxes and toggles, "true" for radio buttons.'
              }
            },
            required: ['uid', 'value'],
            description: 'An element to fill out'
          },
          description: 'Elements from snapshot to fill out.'
        },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'elements'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_type_text',
    lease: true,
    description: 'Type text using keyboard into a previously focused input',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        text: { type: 'string', description: 'The text to type' },
        submitKey: { description: 'Optional key to press after typing. E.g., "Enter", "Tab", "Escape"', type: 'string' }
      },
      required: ['pageId', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_press_key',
    lease: true,
    description:
      'Press a key or key combination. Use this when other input methods like chrome_fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations). Note: On macOS, native <select> elements cannot be operated with ArrowDown/Enter via chrome_press_key; use chrome_fill() on the combobox or chrome_click() on the option instead.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        key: {
          description:
            'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta',
          type: 'string'
        },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'key'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_handle_dialog',
    lease: true,
    description: 'If a browser dialog was opened, use this command to handle it',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        action: { type: 'string', enum: ['accept', 'dismiss'], description: 'Whether to dismiss or accept the dialog' },
        promptText: { description: 'Optional prompt text to enter into the dialog.', type: 'string' }
      },
      required: ['pageId', 'action'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_navigate_page',
    lease: true,
    description: 'Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        type: {
          description: 'Navigate the page by URL, back or forward in history, or reload.',
          type: 'string',
          enum: ['url', 'back', 'forward', 'reload']
        },
        url: { description: 'Target URL (only type=url)', type: 'string' },
        ignoreCache: { description: 'Whether to ignore cache on reload.', type: 'boolean' },
        handleBeforeUnload: {
          description:
            'Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.',
          type: 'string',
          enum: ['accept', 'dismiss']
        },
        timeout: {
          description: 'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.',
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991
        }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_new_page',
    lease: true,
    description: 'Open a new tab and load a URL. Use project URL if not specified otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to load in a new page.' },
        background: {
          description:
            'Whether to open the page in the background without bringing it to the front. Default is false (foreground).',
          type: 'boolean'
        },
        timeout: {
          description: 'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.',
          type: 'integer',
          minimum: -9007199254740991,
          maximum: 9007199254740991
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_select_page',
    lease: true,
    description: 'Select a page as a context for future tool calls.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          description: 'The ID of the page to select. Call chrome_list_pages to get available pages.'
        },
        bringToFront: { description: 'Whether to focus the page and bring it to the top.', type: 'boolean' }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_close_page',
    lease: true,
    description: 'Closes the page by its index. The last open page cannot be closed.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'The ID of the page to close. Call chrome_list_pages to list pages.' }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_upload_file',
    lease: true,
    requires: 'files',
    description: 'Upload a file through a provided element.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        uid: {
          type: 'string',
          description:
            'The uid of the file input element or an element that will open file chooser on the page from the page content snapshot'
        },
        filePaths: {
          minItems: 1,
          type: 'array',
          items: { type: 'string' },
          description:
            'One or more files paths to upload. File paths have to be local to the browser instance (not the MCP).'
        },
        includeSnapshot: {
          description: 'Whether to include a snapshot in the response. Default is false.',
          type: 'boolean'
        }
      },
      required: ['pageId', 'uid', 'filePaths'],
      additionalProperties: false
    }
  },
  {
    name: 'chrome_evaluate_script',
    lease: true,
    requires: 'shell',
    description:
      'Evaluate JavaScript inside the target page. The source can be provided inline or loaded from a local file. Returns the response as JSON, so returned values have to be JSON-serializable.',
    inputSchema: {
      type: 'object',
      properties: {
        pageId: { type: 'string', description: 'Targets a specific page by ID.' },
        function: {
          description:
            'JavaScript source to execute in the target page. Provide either this or sourcePath, but not both. The source is interpreted according to format.\nExample without arguments: `() => document.title` or `async () => await fetch("example.com")`.\nExample with arguments: `(el) => el.innerText`\n',
          type: 'string'
        },
        format: {
          description:
            'How to interpret the source. "function" treats it as a function declaration and supports args. "script" evaluates it as classic JavaScript and does not support args. Defaults to "function". ECMAScript modules are not supported.',
          type: 'string',
          enum: ['function', 'script']
        },
        args: {
          description:
            'An optional list of arguments (element uids from the page content snapshot) to pass to the function.',
          type: 'array',
          items: { type: 'string', description: 'The uid of an element on the page from the page content snapshot' }
        },
        dialogAction: {
          description:
            'Handle dialogs while execution. "accept", "dismiss", or string for response of window.prompt. Defaults to accept.',
          type: 'string'
        },
        waitForStableDom: {
          description:
            'Whether to wait for the DOM to settle. Pass false if the script only reads data. Defaults to true.',
          type: 'boolean'
        }
      },
      required: ['pageId'],
      additionalProperties: false
    }
  }
]

const BY_NAME = new Map(COMPUTER_BROWSER_TOOLS.map((tool) => [tool.name, tool]))

/** The v1 tool of this name, or undefined for any name outside the contract. */
export const computerBrowserTool = (name: string): ComputerBrowserTool | undefined => BY_NAME.get(name)

/** The browser tier a current Control Plane sends, including the default for isolated Computers. */
export function computerBrowserPolicy(policy: ComputerPolicy, isolation: ComputerIsolation) {
  return {
    browserTier: (isolation === 'container' || isolation === 'vm') && policy.browserTier !== false,
    browserHideWebdriver: policy.browserHideWebdriver !== false
  }
}

/** Both daemons use the same navigation classification when checking file and script authority. */
export function computerBrowserAddressSchemes(args: Record<string, unknown>): string[] {
  if (typeof args.url !== 'string') return []
  const address = URL.parse(args.url)
  if (!address) return []
  if (address.protocol !== 'view-source:') return [address.protocol]
  const inner = URL.parse(address.pathname.replace(/^(?:\s*view-source:)+/i, ''))
  return inner ? [address.protocol, inner.protocol] : [address.protocol]
}

export function computerBrowserNeedsShell(tool: ComputerBrowserTool, schemes: readonly string[]): boolean {
  return tool.requires === 'shell' || schemes.some((scheme) => /^(javascript|data|vbscript):$/.test(scheme))
}

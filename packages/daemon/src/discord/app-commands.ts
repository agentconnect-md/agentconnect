import { ApplicationCommandOptionType, type ApplicationCommandDataResolvable } from 'discord.js'

/**
 * Native Discord application (slash) command definitions, registered globally on
 * connect (see DiscordConnection.start → registerCommands). They make the same
 * control vocabulary the daemon already parses from plain `/text` messages
 * (see commands.ts) show up in Discord's `/` autocomplete menu with descriptions
 * and typed arguments.
 *
 * These are NOT a second command engine: a slash invocation is reconstructed back
 * into its `/text` form (DiscordConnection.slashCommandText) and fed through the
 * SAME onInbound → parseCommand → handleCommand path as a typed message, so the
 * names/args here MUST stay in lockstep with parseCommand's vocabulary (guarded by
 * discord-app-commands.test.ts).
 *
 * PREREQUISITE: the bot must be invited with the `applications.commands` OAuth2
 * scope, else `commands.set` fails with 403 Missing Access and nothing appears.
 *
 * The select commands (`/models` `/effort` `/permission`) take an OPTIONAL free-text
 * argument — omitting it lists the choices as a tappable button card (buildDiscord-
 * SelectComponents); passing it selects directly. Choices aren't pre-declared because
 * the offered options are model-dependent and only known once a session is warm.
 */
export const DISCORD_APP_COMMANDS: ApplicationCommandDataResolvable[] = [
  { name: 'status', description: "Show this session's model, context and token usage" },
  {
    name: 'models',
    description: 'List models, or switch (leave blank for a tappable picker)',
    options: [
      { name: 'model', description: 'Model id, name, or list number', type: ApplicationCommandOptionType.String }
    ]
  },
  {
    name: 'effort',
    description: 'List reasoning-effort levels, or switch',
    options: [{ name: 'level', description: 'Effort level or list number', type: ApplicationCommandOptionType.String }]
  },
  {
    name: 'permission',
    description: 'List permission modes, or switch',
    options: [
      { name: 'mode', description: 'Permission mode or list number', type: ApplicationCommandOptionType.String }
    ]
  },
  {
    name: 'fast',
    description: 'Toggle fast mode for this session',
    options: [
      {
        name: 'state',
        description: 'on or off',
        type: ApplicationCommandOptionType.String,
        choices: [
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' }
        ]
      }
    ]
  },
  { name: 'stop', description: 'Stop the agent and mute this thread until @mentioned' },
  { name: 'cancel', description: 'Cancel the in-flight turn (session stays live)' },
  { name: 'resume', description: 'Reset loop protection and unmute this conversation' },
  {
    name: 'queue',
    description: 'Queue a message to run once the agent is idle',
    options: [
      {
        name: 'message',
        description: 'The message to queue',
        type: ApplicationCommandOptionType.String,
        required: true
      }
    ]
  }
]

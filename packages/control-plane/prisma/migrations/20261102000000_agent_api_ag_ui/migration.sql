-- AG-UI joins the chat APIs an agent can add (shared-bot-relay.md §10.4).
ALTER TYPE "AgentApiProtocol" ADD VALUE IF NOT EXISTS 'ag-ui';

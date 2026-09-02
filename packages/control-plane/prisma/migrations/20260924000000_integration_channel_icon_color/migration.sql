-- A conversation's own display glyph and tint (docs/designs/linear-integration.md §4.5): a Linear
-- team carries an icon (a provider icon name such as "Feather", or an emoji) and a hex color, and
-- the console draws them the way Linear's own team picker does.
--
-- Additive and nullable: every existing row keeps rendering exactly as it did, and Linear rows are
-- re-stamped by the connect tail, the credential reconciler's team pass, and the daemon's next
-- conversation report. No other platform ever writes them.
ALTER TABLE "integration_channel" ADD COLUMN "icon" TEXT;
ALTER TABLE "integration_channel" ADD COLUMN "color" TEXT;

-- Bind a reconnect nonce to the workspace it is repairing (docs/designs/linear-integration.md §7.4).
--
-- A reconnect funnel row previously recorded only its organization and initiating user, so the
-- callback could not tell "the workspace this nonce was minted for" from "any workspace of this
-- organization". Authorizing a different, already-connected workspace would then rotate THAT
-- workspace's grant and settle the connect completed, while the dead workspace the operator set out
-- to repair stayed dead. The expected bot makes the callback's identity check exact.

ALTER TABLE "linear_install_state" ADD COLUMN "expectedBotId" UUID;

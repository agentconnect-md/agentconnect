-- Retired conversations invalidate authorization, but their published protocol identities stay occupied.
ALTER TABLE "ahp_session_binding" DROP CONSTRAINT "ahp_session_binding_conversationId_fkey";

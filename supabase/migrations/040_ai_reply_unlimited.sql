-- ============================================================
-- 040_ai_reply_unlimited.sql — remove the per-conversation auto-
-- reply cap
--
-- The auto-reply bot answers a thread as often as the customer
-- messages it. The per-conversation `max_replies` cap (migration
-- 029) is removed: the account-wide rate limit (`aiAutoReplyAccount`)
-- and the model-driven handoff still bound runaway spend, so a
-- chatty customer in one thread no longer silences the bot.
--
--   - Drops `ai_configs.auto_reply_max_per_conversation` (the CHECK
--     constraint goes with it).
--   - Replaces `claim_ai_reply_slot(uuid, integer)` with an
--     uncapped `claim_ai_reply_slot(uuid)`: it still atomically
--     increments the per-thread reply count (kept for stats and the
--     handoff summary) and reports whether the conversation exists,
--     but never refuses a slot.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE ai_configs
  DROP COLUMN IF EXISTS auto_reply_max_per_conversation;

DROP FUNCTION IF EXISTS public.claim_ai_reply_slot(uuid, integer);

-- ============================================================
-- Atomic auto-reply slot claim (uncapped).
--
-- Counts the reply for stats / handoff context and confirms the
-- conversation still exists. No cap arithmetic: every inbound that
-- reaches the send point may reply. All under the service-role
-- client (the inbound webhook has no auth.uid()).
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  conversation_id uuid
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = conversation_id
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Only the service role claims slots, so grant to it alone (mirrors
-- 007 / 012 / 031 / 029).
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid) TO service_role;
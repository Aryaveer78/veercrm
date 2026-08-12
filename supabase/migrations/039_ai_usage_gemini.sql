-- 039_ai_usage_gemini.sql
-- Allow Gemini usage rows in the AI usage ledger.
-- The original 033_ai_reply_polish migration only allowed OpenAI and Anthropic.

ALTER TABLE ai_usage_log
  DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;

ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

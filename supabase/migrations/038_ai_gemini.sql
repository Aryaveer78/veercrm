-- 038_ai_gemini.sql — add Google Gemini as an AI reply provider.
--
-- Existing ai_configs rows are unchanged. The provider remains a
-- per-account BYO key and is encrypted by the application with
-- ENCRYPTION_KEY, just like OpenAI and Anthropic keys.

ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_provider_check;

ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

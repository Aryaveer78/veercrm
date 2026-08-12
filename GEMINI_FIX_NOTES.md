# Gemini fix notes

## Current status

- Gemini draft generation is working.
- A `400 Requests ending with a model turn are not supported` from the first
  structured request is handled by the Gemini adapter's flattened fallback.
- The fallback then successfully generates the draft (`POST /api/ai/draft 200`).
- The remaining console error is only usage logging: the database constraint
  on `ai_usage_log.provider` still allowed only `openai` and `anthropic`.

## Required Supabase migration

Apply:

`supabase/migrations/039_ai_usage_gemini.sql`

It changes the `ai_usage_log_provider_check` constraint to allow:

- `openai`
- `anthropic`
- `gemini`

After the migration, the `[ai usage] log insert failed: code 23514` message
will stop for Gemini calls.

import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[]
    }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: {
    message?: string
    status?: string
    code?: number
  }
}

function normalizeModelId(model: string): string {
  const trimmed = model.trim()
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed
}

/**
 * Gemini expects `model` instead of `assistant` and conversation turns
 * should alternate. Leading assistant turns are discarded because
 * GenerateContent expects the first content turn to be from the user.
 */
function normalizeForGemini(messages: ChatMessage[]) {
  const merged = mergeConsecutive(messages)
    .filter((m) => m.content.trim())
    .map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content.trim() }],
    }))

  // Gemini GenerateContent requests must end with a user turn when
  // asking the model to generate the next assistant reply. If the
  // conversation currently ends with an assistant turn, remove that
  // trailing model turn. The draft should be generated from the latest
  // customer/user message, not from an already-sent assistant reply.
  while (merged.length > 0 && merged[0].role === 'model') {
    merged.shift()
  }

  while (merged.length > 0 && merged[merged.length - 1].role === 'model') {
    merged.pop()
  }

  if (merged.length === 0) {
    return [
      {
        role: 'user' as const,
        parts: [{ text: '(The customer has not sent a message yet.)' }],
      },
    ]
  }

  return merged
}

function extractText(data: GeminiResponse | null): string {
  return data?.candidates?.[0]?.content?.parts
    ?.filter((part) => typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('')
    .trim() ?? ''
}

function buildStandardBody(
  systemPrompt: string,
  messages: ChatMessage[],
): Record<string, unknown> {
  return {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: normalizeForGemini(messages),
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  }
}

/**
 * Fallback payload for providers/models that reject a structured
 * systemInstruction + multi-turn transcript. It preserves the same
 * instructions and conversation but sends them as one user turn.
 */
function buildFlattenedBody(
  systemPrompt: string,
  messages: ChatMessage[],
): Record<string, unknown> {
  const cleaned = mergeConsecutive(messages)
    .filter((m) => m.content.trim())

  // Do not include a trailing assistant/model turn in the final prompt.
  // Gemini rejects requests whose last content turn is a model turn.
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].role === 'assistant') {
    cleaned.pop()
  }

  const transcript = cleaned
    .map((m) => `${m.role === 'assistant' ? 'Business/assistant' : 'Customer'}: ${m.content.trim()}`)
    .join('\n\n')

  return {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `${systemPrompt}\n\n` +
              'Recent WhatsApp conversation:\n\n' +
              transcript +
              '\n\nWrite only the next reply the business should send to the customer.',
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    },
  }
}

async function postGemini(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
}

/**
 * Call Google's Gemini GenerateContent endpoint with the account's own
 * API key. The normal request uses Gemini's native systemInstruction and
 * multi-turn format. For a 400 response, retry once with a flattened
 * single-turn payload. This makes draft generation resilient to model
 * variants that reject a particular structured conversation payload while
 * keeping the normal path fully native.
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args
  const modelId = normalizeModelId(model)

  if (!modelId) {
    throw new AiError('Gemini model is required.', {
      code: 'invalid_model',
      status: 400,
    })
  }

  const url = `${GEMINI_URL}/${encodeURIComponent(modelId)}:generateContent`

  let res = await postGemini(
    url,
    apiKey,
    buildStandardBody(systemPrompt, messages),
    timeoutMs,
  )

  // Some Gemini model variants reject structured system instructions or
  // a particular multi-turn transcript with HTTP 400. Retry once using
  // a conservative single-turn representation before surfacing the error.
  if (res.status === 400) {
    const firstError = await res.clone().json().catch(() => null) as GeminiResponse | null
    console.warn('[ai/gemini] structured request rejected; retrying flattened request:', {
      status: res.status,
      message: firstError?.error?.message,
      model: modelId,
    })

    res = await postGemini(
      url,
      apiKey,
      buildFlattenedBody(systemPrompt, messages),
      timeoutMs,
    )
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = extractText(data)

  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason
    throw new AiError(
      finishReason
        ? `Gemini returned no text (finish reason: ${finishReason}).`
        : 'Gemini returned an empty response.',
      {
        code: 'empty_response',
      },
    )
  }

  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })

  return { text, usage }
}

/**
 * DeepSeek client (OpenAI-compatible API).
 * No SDK — just fetch.
 *
 * Models:
 *   deepseek-chat     — V3, fast + cheap, default for narrative
 *   deepseek-reasoner — has chain-of-thought; reserve for complex analysis
 *
 * Pricing (as of 2026):
 *   chat: $0.14 / 1M input, $0.28 / 1M output (cached input: $0.014 / 1M)
 *
 * Strict JSON mode: when `jsonSchema` is provided we add response_format
 * + schema in the system prompt for reliability.
 */

const base = process.env.DEEPSEEK_BASE ?? 'https://api.deepseek.com'
const apiKey = process.env.DEEPSEEK_API_KEY ?? ''

export type AiMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AiOptions = {
  model?: 'deepseek-chat' | 'deepseek-reasoner' | 'deepseek-v4-pro' | 'deepseek-v4-flash'
  temperature?: number
  maxTokens?: number
  json?: boolean
}

export type AiResult = {
  text: string
  usage?: {
    promptTokens: number
    completionTokens: number
    cachedTokens?: number
  }
}

export async function chat(messages: AiMessage[], opts: AiOptions = {}): Promise<AiResult> {
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not configured')

  const body: Record<string, unknown> = {
    model: opts.model ?? 'deepseek-chat',
    messages,
    temperature: opts.temperature ?? 0.6,
    max_tokens: opts.maxTokens ?? 800
  }
  if (opts.json) {
    body.response_format = { type: 'json_object' }
  }

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000) // 45s timeout — prevent indefinite hangs
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`DeepSeek ${res.status}: ${text.slice(0, 300)}`)
  }

  const data = (await res.json()) as any
  const choice = data?.choices?.[0]
  if (!choice) throw new Error('DeepSeek: no choices in response')

  const text: string = choice.message?.content ?? ''

  // Warn on token-limit truncation — model output may be incomplete JSON
  if (choice.finish_reason === 'length') {
    console.warn(`[ai] response truncated (finish_reason=length, max_tokens=${body.max_tokens}, output_len=${text.length})`)
  }

  const usage = data?.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        cachedTokens: data.usage.prompt_cache_hit_tokens
      }
    : undefined

  return { text, usage }
}

/**
 * Convenience for JSON-mode calls. Throws if model returned malformed JSON.
 */
function previewForError(raw: string, max = 400): string {
  if (raw.length === 0) return '(empty — model returned no assistant text)'
  const s = raw.length > max ? raw.slice(0, max) + '…' : raw
  return JSON.stringify(s)
}

/** If the model wraps JSON in ``` / ```json fences, strip them before parse. */
function unwrapMarkdownJson(raw: string): string {
  let t = raw.trim()
  if (!t.startsWith('```')) return t
  t = t.replace(/^```(?:json)?\s*\n?/i, '')
  const end = t.lastIndexOf('```')
  if (end >= 0) t = t.slice(0, end)
  return t.trim()
}

export async function chatJson<T>(
  messages: AiMessage[],
  opts: AiOptions = {}
): Promise<{ data: T; usage?: AiResult['usage'] }> {
  const res = await chat(messages, { ...opts, json: true })
  const raw = res.text ?? ''
  try {
    const toParse = unwrapMarkdownJson(raw)
    return { data: JSON.parse(toParse) as T, usage: res.usage }
  } catch (e) {
    const len = raw.length
    const head = raw.slice(0, 4000)
    console.error('[ai/chatJson] JSON.parse failed; assistant len=', len, 'first bytes=', head.slice(0, 200))
    if (len > 400) console.error('[ai/chatJson] …tail…', raw.slice(-800))
    throw new Error(
      `DeepSeek returned non-JSON (len=${len}): ${previewForError(raw)} | ${(e as Error).message}`
    )
  }
}

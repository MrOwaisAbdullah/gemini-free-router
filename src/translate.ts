import type {
  OpenAIChatRequest,
  GeminiRequest,
  GeminiContent,
  GeminiPart,
  ChatMessage,
  OpenAIEmbeddingRequest,
  GeminiResponse,
} from "./types.ts";

export interface EmbeddingUsage {
  promptTokenCount: number;
  totalTokenCount: number;
}

/** OpenAI chat.completions request → Gemini generateContent request. */
export function openaiToGemini(req: OpenAIChatRequest): GeminiRequest {
  const contents: GeminiContent[] = [];
  let systemParts: GeminiPart[] | undefined;

  for (const msg of req.messages ?? []) {
    const parts = geminiPartsOf(msg.content);
    if (msg.role === "system") {
      // Live-verified: Gemini accepts inline_data inside systemInstruction.
      systemParts = systemParts ? [...systemParts, ...parts] : parts;
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts });
    } else {
      contents.push({ role: "user", parts });
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  if (typeof req.max_tokens === "number") generationConfig.maxOutputTokens = req.max_tokens;
  if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  const out: GeminiRequest = { contents };
  if (systemParts) out.systemInstruction = { parts: systemParts };
  if (Object.keys(generationConfig).length) out.generationConfig = generationConfig;
  return out;
}

/** OpenAI content (string | parts array) → Gemini parts, images included. */
function geminiPartsOf(content: ChatMessage["content"]): GeminiPart[] {
  if (content == null) return [{ text: "" }];
  if (typeof content === "string") return [{ text: content }];
  const parts: GeminiPart[] = [];
  for (const p of content) {
    if (p.type === "image_url") {
      const url = p.image_url?.url;
      if (url) parts.push(imagePartOf(url));
    } else if (typeof p.text === "string") {
      parts.push({ text: p.text });
    }
  }
  return parts.length ? parts : [{ text: "" }];
}

const DATA_URI = /^data:([^;,]*)((?:;[^,]*)?),([\s\S]*)$/;

function imagePartOf(url: string): GeminiPart {
  const m = DATA_URI.exec(url);
  if (m && /;base64/i.test(m[2] ?? "")) {
    const mime = m[1] && m[1].includes("/") ? m[1] : "application/octet-stream";
    return { inline_data: { mime_type: mime, data: m[3] } };
  }
  if (/^(https?|gs):\/\//i.test(url)) {
    const mime = mimeFromUrl(url);
    return mime ? { file_data: { file_uri: url, mime_type: mime } } : { file_data: { file_uri: url } };
  }
  // Unknown scheme (incl. non-base64 data URIs): pass through as file_data so
  // Gemini's own validation error reaches the client instead of the image
  // being silently dropped.
  return { file_data: { file_uri: url } };
}

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function mimeFromUrl(url: string): string | undefined {
  const path = url.split(/[?#]/)[0];
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext];
}

function estimateImageTokens(): number {
  // Measured live on gemini-3.5-flash-lite (2026-10-14): media tokenization is
  // ~flat for standard sizes — 512x512=1092, 768x512=1083, 1024x1024=1092,
  // 1536x1024=1086 prompt tokens, independent of byte size (198KB..1.19MB).
  // So a flat per-image estimate beats any byte/dimension heuristic; the
  // ledger still replaces it with the actual promptTokenCount on success.
  return 1100;
}

/** Cheap pre-call input-token estimate (text chars/4 + images + per-message overhead). */
export function estimateInputTokens(req: OpenAIChatRequest): number {
  let chars = 0;
  let imageTokens = 0;
  let messages = 0;
  for (const msg of req.messages ?? []) {
    messages += 1;
    const content = msg.content;
    if (content == null) continue;
    if (typeof content === "string") {
      chars += content.length;
      continue;
    }
    for (const p of content) {
      if (p.type === "image_url") {
        if (p.image_url?.url) imageTokens += estimateImageTokens();
      } else if (typeof p.text === "string") {
        chars += p.text.length;
      }
    }
  }
  return Math.max(16, Math.ceil(chars / 4) + imageTokens + messages * 4);
}

/** Gemini generateContent response → OpenAI chat.completion. */
export function geminiToOpenAI(
  g: GeminiResponse,
  model: string,
  id = completionId(),
  created = Math.floor(Date.now() / 1000),
) {
  const u = g.usageMetadata ?? {};
  const blocked = g.candidates?.[0]?.content?.parts?.[0]?.text
    ? !!(g.candidates?.[0]?.finishReason && g.candidates?.[0]?.finishReason !== "STOP")
    : !!(g.promptFeedback?.blockReason);
  return {
    id,
    object: "chat.completion" as const,
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: blocked ? null : textOfGemini(g),
        },
        finish_reason: blocked ? "content_filter" : "stop",
      },
    ],
    usage: {
      prompt_tokens: u.promptTokenCount ?? 0,
      completion_tokens: u.candidatesTokenCount ?? 0,
      total_tokens: u.totalTokenCount ?? 0,
    },
  };
}

function textOfGemini(g: GeminiResponse): string {
  const parts = g.candidates?.[0]?.content?.parts?.filter((p) => p.text) || [];
  return parts.map((p) => p.text).join("");
}

let idCounter = 0;
export function completionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

/** Parse Gemini SSE (`data: {...}` lines) into response objects. */
export function parseGeminiSseLine(line: string): GeminiResponse | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Build one OpenAI SSE chunk from a partial Gemini response. */
export function geminiChunkToOpenAI(
  g: GeminiResponse,
  model: string,
  id: string,
  created: number,
  includeUsage: boolean,
) {
  const text = textOfGemini(g);
  const done = !!g.candidates?.[0]?.finishReason;
  const chunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: text ? { content: text } : {},
        finish_reason: done ? "stop" : null,
      },
    ],
  };
  // OpenAI sends `usage: null` on every content chunk when
  // stream_options.include_usage is set; the real counts arrive in a final
  // empty-choices chunk (emitted by server.ts after the stream drains).
  if (includeUsage) chunk.usage = null;
  return chunk;
}

export function sseFrame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function openaiError(status: number, message: string, type: string, code?: string) {
  return {
    error: { message, type, code: code ?? status, param: null },
  };
}

/**
 * OpenAI embeddings request → Gemini embed request.
 * Live-verified against v1beta (dev-log §1.17):
 *  - 1 input  → `:embedContent`, body `{content}` (no model field — adding one
 *    is fine, but `requests` is rejected outright);
 *  - n inputs → `:batchEmbedContents`, body `{requests:[{model:"models/…", content}]}`
 *    — `model` is required on every request.
 * The two endpoints accept each other's body shapes never; the old code sent
 * `{requests:[…]}` to the singular endpoint and got a 400 for every call.
 */
export function openaiToGeminiEmbedding(req: OpenAIEmbeddingRequest): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const model = req.model;
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  if (inputs.length === 1) {
    return {
      endpoint: `/models/${model}:embedContent`,
      body: { content: { parts: [{ text: inputs[0] }] } },
    };
  }
  return {
    endpoint: `/models/${model}:batchEmbedContents`,
    body: {
      requests: inputs.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      })),
    },
  };
}

/** Real Gemini embedContent / batchEmbedContents response (verified live). */
export interface GeminiEmbeddingResponse {
  embedding?: { values: number[] };
  embeddings?: Array<{ values: number[] }>;
}

/**
 * → OpenAI embeddings response. Gemini returns no `usageMetadata` on either
 * embed endpoint, so the caller passes its token estimate and we expose the
 * OpenAI-compat `usage: {prompt_tokens, total_tokens}`.
 */
export function geminiToOpenAIEmbedding(g: GeminiEmbeddingResponse, model: string, promptTokens: number) {
  const vectors = g.embedding ? [g.embedding.values] : (g.embeddings ?? []).map((e) => e.values);
  return {
    object: "list" as const,
    data: vectors.map((embedding, index) => ({ embedding, index })),
    model,
    usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
  };
}

/** Parse OpenAI embeddings SSE line (if using batch embedContents with SSE). */
export function parseGeminiEmbeddingSseLine(line: string): {
  data: Array<{ embedding: number[]; index: number }>;
} | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const parsed = JSON.parse(payload) as { data?: Array<{ embedding: number[]; index: number }> };
    return {
      data: parsed.data?.map((d) => ({
        embedding: d.embedding,
        index: d.index,
      })) || [],
    };
  } catch {
    return null;
  }
}
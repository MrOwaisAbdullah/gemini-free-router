import type {
  OpenAIChatRequest,
  GeminiRequest,
  GeminiContent,
  GeminiPart,
  GeminiFunctionDeclaration,
  ChatMessage,
  OpenAIToolCall,
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
  // tool_call_id → function name, filled while walking (an assistant
  // tool_calls message always precedes its role:"tool" results), because
  // OpenAI tool messages carry only the id — the name must be recovered here
  // for the functionResponse Gemini expects.
  const toolNameById = new Map<string, string>();

  for (const msg of req.messages ?? []) {
    if (msg.role === "system") {
      // Live-verified: Gemini accepts inline_data inside systemInstruction.
      const parts = geminiPartsOf(msg.content);
      systemParts = systemParts ? [...systemParts, ...parts] : parts;
      continue;
    }
    if (msg.role === "assistant") {
      const calls = msg.tool_calls ?? [];
      // A tool_calls turn typically has content: null — don't emit an empty
      // text part next to the functionCall parts.
      const parts = calls.length && msg.content == null ? [] : geminiPartsOf(msg.content);
      for (const tc of calls) {
        if (!tc?.function?.name) continue;
        toolNameById.set(tc.id ?? "", tc.function.name);
        // Gemini 3 demands its thought_signature back when a signed
        // functionCall is replayed — re-attach what was remembered when this
        // tool_call id was served (and Gemini's own functionCall id, which
        // the signature covers).
        const memo = tc.id ? callMemo.get(tc.id) : undefined;
        const functionCall: GeminiPart["functionCall"] = {
          name: tc.function.name,
          args: parseToolArgs(tc.function.arguments),
        };
        if (memo?.geminiId) functionCall.id = memo.geminiId;
        const part: GeminiPart = { functionCall };
        if (memo?.signature) part.thoughtSignature = memo.signature;
        parts.push(part);
      }
      contents.push({ role: "model", parts });
      continue;
    }
    if (msg.role === "tool") {
      const name = msg.name || toolNameById.get(msg.tool_call_id ?? "") || "tool";
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response: toolResponseOf(msg.content) } }],
      });
      continue;
    }
    contents.push({ role: "user", parts: geminiPartsOf(msg.content) });
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  if (typeof req.max_tokens === "number") generationConfig.maxOutputTokens = req.max_tokens;
  if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  const out: GeminiRequest = { contents };
  if (systemParts) out.systemInstruction = { parts: systemParts };
  if (Object.keys(generationConfig).length) out.generationConfig = generationConfig;

  // Function calling (v0.4.0). Before this existed `tools`/`tool_choice` were
  // silently dropped — the model never saw the declarations, never called a
  // function, and tool-driven agents (contentfte research/brief stages, CI
  // 2026-10-15) received empty outputs. The router carries declarations and
  // results only; executing tools stays the client's job.
  const declarations: GeminiFunctionDeclaration[] = [];
  for (const t of req.tools ?? []) {
    if (t?.type !== "function" || !t.function?.name) continue;
    const d: GeminiFunctionDeclaration = { name: t.function.name };
    if (t.function.description) d.description = t.function.description;
    if (t.function.parameters) d.parameters = t.function.parameters;
    declarations.push(d);
  }
  // tool_choice "none" = the model must not call anything: omitting the
  // declarations entirely is Gemini's strictest form of that.
  if (declarations.length && req.tool_choice !== "none") {
    out.tools = [{ functionDeclarations: declarations }];
    const toolConfig = toolConfigOf(req.tool_choice);
    if (toolConfig) out.toolConfig = toolConfig;
  }
  return out;
}

/** OpenAI tool_call.arguments (a JSON string) → the object Gemini expects. */
function parseToolArgs(args: string | undefined): Record<string, unknown> {
  if (!args) return {};
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return { value: v };
  } catch {
    return {};
  }
}

/**
 * OpenAI role:"tool" content → the Struct Gemini's functionResponse requires.
 * JSON objects pass through as-is (that's the natural shape every SDK sends);
 * anything else is wrapped in `output`, Google's own convention for
 * non-Struct payloads.
 */
function toolResponseOf(content: ChatMessage["content"]): Record<string, unknown> {
  let raw: unknown = content;
  if (Array.isArray(content)) {
    raw = content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  }
  if (raw == null) return {};
  if (typeof raw !== "object") {
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
        return { output: parsed };
      } catch {
        return { output: raw };
      }
    }
    return { output: raw };
  }
  if (Array.isArray(raw)) return { output: raw };
  return raw as Record<string, unknown>;
}

/** OpenAI `tool_choice` → Gemini toolConfig; undefined when the default applies. */
function toolConfigOf(choice: OpenAIChatRequest["tool_choice"]): GeminiRequest["toolConfig"] {
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (choice && typeof choice === "object" && choice.function?.name) {
    return {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] },
    };
  }
  // "auto"/unset → Gemini's AUTO is the default; "none" never reaches here
  // (declarations are omitted above).
  return undefined;
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
  const toolCalls = functionCallsOf(g);
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
          // OpenAI-compatible clients (the Agents SDK included) read
          // tool_calls off the message; without this mapping a Gemini
          // functionCall part collapsed into an empty assistant message,
          // the SDK had nothing to execute, and tool-driven runs ended
          // with empty output (dev-log §1.21).
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: blocked ? "content_filter" : toolCalls.length ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: u.promptTokenCount ?? 0,
      completion_tokens: u.candidatesTokenCount ?? 0,
      total_tokens: u.totalTokenCount ?? 0,
    },
  };
}

/**
 * OpenAI tool_call.id → Gemini's {id, thoughtSignature} from the response
 * that produced it. Gemini 3 signs its functionCall parts and rejects the
 * replay without the signature, but the OpenAI wire format has nowhere to
 * carry one — so the router remembers its own generated id → signature and
 * re-attaches it when the client echoes the id back. Bounded FIFO: oldest
 * entries evict past the cap (a call is consumed within seconds-to-minutes;
 * an idle cache never fills, and a mid-conversation router restart degrades
 * to the upstream 400 → client's normal error fallback).
 */
const callMemo = new Map<string, { geminiId?: string; signature?: string }>();
const CALL_MEMO_MAX = 4096;

function rememberCall(id: string, geminiId?: string, signature?: string) {
  if (!geminiId && !signature) return;
  callMemo.set(id, { geminiId, signature });
  while (callMemo.size > CALL_MEMO_MAX) {
    const oldest = callMemo.keys().next().value;
    if (oldest === undefined) break;
    callMemo.delete(oldest);
  }
}

/** Gemini functionCall parts → OpenAI `tool_calls` entries (v0.4.0). */
function functionCallsOf(g: GeminiResponse): OpenAIToolCall[] {
  const calls: OpenAIToolCall[] = [];
  let i = 0;
  for (const p of g.candidates?.[0]?.content?.parts ?? []) {
    if (!p.functionCall?.name) continue;
    // Unique within (and across) responses; the client echoes this id back
    // on the assistant repeat + role:"tool" result, which openaiToGemini
    // resolves to the function name and the memoized Gemini id/signature.
    const id = `call_${completionId().replace("chatcmpl-", "")}_${i++}`;
    rememberCall(id, p.functionCall.id, p.thoughtSignature);
    calls.push({
      id,
      type: "function",
      function: {
        name: p.functionCall.name,
        arguments: JSON.stringify(p.functionCall.args ?? {}),
      },
    });
  }
  return calls;
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
  const toolCalls = functionCallsOf(g).map((tc, index) => ({ index, ...tc }));
  const done = !!g.candidates?.[0]?.finishReason;
  // OpenAI streaming tool_calls deltas carry a running `index` (the client
  // accumulates by it); Gemini delivers a functionCall part whole, so each
  // one arrives as a single complete delta.
  const delta: Record<string, unknown> = {};
  if (text) delta.content = text;
  if (toolCalls.length) delta.tool_calls = toolCalls;
  const chunk: Record<string, unknown> = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: done ? (toolCalls.length ? "tool_calls" : "stop") : null,
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
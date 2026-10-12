export interface EmbeddingUsage {
  promptTokenCount: number;
  totalTokenCount: number;
}

/** OpenAI chat.completions request → Gemini generateContent request. */
export function openaiToGemini(req: OpenAIChatRequest): GeminiRequest {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: { text: string }[] } | undefined;

  for (const msg of req.messages ?? []) {
    const t = textOf(msg.content);
    if (msg.role === "system") {
      systemInstruction = systemInstruction
        ? { parts: [...systemInstruction.parts, { text: t }] }
        : { parts: [{ text: t }] };
    } else if (msg.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: t }] });
    } else {
      contents.push({ role: "user", parts: [{ text: t }] });
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  if (typeof req.max_tokens === "number") generationConfig.maxOutputTokens = req.max_tokens;
  if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

  const out: GeminiRequest = { contents };
  if (systemInstruction) out.systemInstruction = systemInstruction;
  if (Object.keys(generationConfig).length) out.generationConfig = generationConfig;
  return out;
}

function textOf(content: ChatMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/** Cheap pre-call input-token estimate (chars/4 + per-message overhead). */
export function estimateInputTokens(req: OpenAIChatRequest): number {
  let chars = 0;
  let messages = 0;
  for (const msg of req.messages ?? []) {
    chars += textOf(msg.content).length;
    messages += 1;
  }
  return Math.max(16, Math.ceil(chars / 4) + messages * 4);
}

/** Gemini generateContent response → OpenAI chat.completion. */
export function geminiToOpenAI(
  g: { candidates?: { content?: { parts?: { text: string } }[] }; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } },
  model: string,
  id = completionId(),
  created = Math.floor(Date.now() / 1000),
) {
  const u = g.usageMetadata ?? {};
  const blocked = !!g.candidates?.[0]?.content?.parts?.[0]?.text
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

function textOfGemini(g: { candidates?: { content?: { parts?: { text: string } }[] } }): string {
  const parts = g.candidates?.[0]?.content?.parts?.filter((p) => p.text) || [];
  return parts.map((p) => p.text).join("");
}

let idCounter = 0;
export function completionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${(idCounter++).toString(36)}`;
}

/** Parse Gemini SSE (`data: {...}` lines) into response objects. */
export function parseGeminiSseLine(line: string): { candidates?: { content?: { parts?: { text: string } }[] } } | null {
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
  g: { candidates?: { content?: { parts?: { text: string } }[] } },
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
  if (done && includeUsage) {
    // usage info is embedded in the final chunk per OpenAI spec
    // we extract it from the Gemini response if available
  }
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

/** OpenAI embeddings request → Gemini embedContent request. */
export function openaiToGeminiEmbedding(req: OpenAIEmbeddingRequest): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const model = req.model;
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const requests = inputs.map((text) => ({
    content: { parts: [{ text }] },
  }));
  const body = { requests };
  const endpoint = `/models/${model}:embedContent`;
  return { endpoint, body };
}

/** Gemini embedContent response → OpenAI embeddings response. */
export function geminiToOpenAIEmbedding(
  g: { data: Array<{ embedding: number[]; index: number } >; usage: { promptTokenCount: number; totalTokenCount: number } },
  model: string,
) {
  const data = g.data.map((item) => ({
    embedding: item.embedding,
    index: item.index,
  }));
  return {
    object: "list" as const,
    data,
    model,
    usage: {
      promptTokenCount: g.usage.promptTokenCount,
      totalTokenCount: g.usage.totalTokenCount,
    },
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
    const parsed = JSON.parse(payload);
    return {
      data: parsed.data?.map((d: any) => ({
        embedding: d.embedding,
        index: d.index,
      })) || [],
    };
  } catch {
    return null;
  }
}
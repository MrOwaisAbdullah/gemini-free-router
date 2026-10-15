export type ModelTier = "bulk" | "standard" | "scarce";
export type ModelModality = "chat" | "embeddings";

export interface FleetModel {
  model: string;
  rpm: number;
  rpd: number;
  tpm: number;
  tier: ModelTier;
  /** default "chat" */
  modality?: ModelModality;
  /** optional alias exposed on /v1/models */
  alias?: string;
}

/**
 * `modality` filter for candidate selection. `"chat"` matches every model that
 * is not explicitly `embeddings` (modality defaults to chat); `"embeddings"`
 * matches only embedding models; `undefined` matches everything.
 *
 * This guard is load-bearing: embedding models carry the fleet's largest
 * budgets (100 RPM vs 5-15), so an unfiltered chat ranking would schedule
 * chat traffic onto them first — a live-smoke finding (dev-log §1.17).
 */
export function matchesModality(m: FleetModel, modality?: ModelModality): boolean {
  if (!modality) return true;
  if (modality === "chat") return (m.modality ?? "chat") === "chat";
  return m.modality === modality;
}

export interface RouterConfig {
  project: string;
  listen: { host: string; port: number };
  gemini: {
    base_url: string;
    api_key_env: string;
  };
  fleet: FleetModel[];
  /**
   * "replace" (default): a config file's `fleet` is the entire fleet.
   * "merge": config entries merge onto the built-in defaults by model id —
   * listed ids override just the fields given, unknown ids are appended,
   * `disabled` then drops ids. Lets limits/models be maintained without
   * editing code.
   */
  fleet_mode?: "replace" | "merge";
  /**
   * Account plan behind the API key: "free" (default) or "pro".
   * Only scales the BUILT-IN default fleet (free-tier screenshot limits are
   * the 1x reference; pro starts at 4x Google's published Pro-vs-free ratio).
   * Explicit config-file fleet numbers always win — copy your account's
   * exact per-model limits from aistudio.google.com/rate-limit instead.
   * The 429 forensics learner converges optimistic starts to real limits.
   */
  plan?: "free" | "pro";
  /** Model ids to drop from the fleet (deprecation), applied after fleet_mode. */
  disabled?: string[];
  pacing: PacingConfig;
  fallback: { strategy: "remaining-budget" };
  learning: LearningConfig;
  modalities: string[];
  auth?: { token?: string };
  ledger_path: string;
  dry_run: boolean;
}

export interface PacingConfig {
  max_queue_wait_s: number;
  burn_curve: "even" | "front-loaded";
  max_in_flight_per_model: number | "auto";
}

export interface LearningConfig {
  auto_apply: boolean;
}

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  /** Plain JSON Schema (the shape every OpenAI-compatible SDK sends). */
  parameters?: Record<string, unknown>;
}

/** OpenAI `tool_choice`: keyword, or pin one function. */
export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type?: string; function?: { name: string } };

export interface OpenAIToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface OpenAIChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  user?: string;
  /** OpenAI function tools — translated to Gemini functionDeclarations (v0.4.0). */
  tools?: Array<{ type?: string; function?: OpenAIFunctionDef }>;
  tool_choice?: OpenAIToolChoice;
}

export interface OpenAIEmbeddingRequest {
  model: string;
  input: string | string[];
  user?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  // OpenAI vision parts carry image_url; `detail` (low|high|auto) has no
  // equivalent in generateContent and is ignored on translation.
  content:
    | string
    | Array<{ type: string; text?: string; image_url?: { url?: string; detail?: string } }>
    | null;
  /** assistant turns: the functions the model asked the client to execute. */
  tool_calls?: OpenAIToolCall[];
  /** tool turns: which call this answers (its id is how the name is recovered). */
  tool_call_id?: string;
  /** optional function name on a tool message (clients that send it). */
  name?: string;
}

/**
 * One Gemini request part. Exactly one field is set per part in practice
 * (text XOR inline_data XOR file_data); all fields are optional so the
 * text-only call sites keep reading `.text` without narrowing.
 */
export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
  file_data?: { file_uri: string; mime_type?: string };
  /** Function calling (v0.4.0): model→client call, client→model result. */
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown> };
  /**
   * Gemini 3 signs functionCall parts and 400s a replay that lacks the
   * signature ("Function call is missing a thought_signature") — re-attached
   * on replay because the OpenAI wire has nowhere to carry it (see callMemo).
   */
  thoughtSignature?: string;
}

export interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

/** One Gemini `functionDeclarations` entry (name/description/parameters JSON Schema). */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: Record<string, unknown>;
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  /** Absent = Gemini's AUTO default; set for tool_choice required/pinned. */
  toolConfig?: {
    functionCallingConfig: { mode?: "AUTO" | "ANY" | "NONE"; allowedFunctionNames?: string[] };
  };
}

export interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
        thoughtSignature?: string;
      }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  promptFeedback?: { blockReason?: string };
}

export interface QuotaSignal {
  kind: "daily" | "minute" | "token_minute" | "unknown";
  quotaId?: string;
  quotaMetric?: string;
  model?: string;
  retryDelayMs: number;
  learnedLimit?: number;
}

export interface ReserveResult {
  ok: boolean;
  waitMs?: number;
  doneForDay?: boolean;
  reason?: string;
}
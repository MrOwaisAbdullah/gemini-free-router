import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openaiToGemini,
  estimateInputTokens,
  geminiToOpenAI,
  geminiChunkToOpenAI,
  parseGeminiSseLine,
} from "../src/translate.ts";
import type { OpenAIChatRequest } from "../src/types.ts";

const req: OpenAIChatRequest = {
  model: "auto",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: [{ type: "text", text: "how are you?" }] },
  ],
  temperature: 0.2,
  top_p: 0.9,
  max_tokens: 100,
};

test("openaiToGemini maps system/user/assistant and generation config", () => {
  const g = openaiToGemini(req);
  assert.equal(g.systemInstruction?.parts[0].text, "be brief");
  assert.equal(g.contents.length, 3);
  assert.equal(g.contents[0].role, "user");
  assert.equal(g.contents[1].role, "model");
  assert.equal(g.contents[2].parts[0].text, "how are you?");
  assert.equal(g.generationConfig?.temperature, 0.2);
  assert.equal(g.generationConfig?.topP, 0.9);
  assert.equal(g.generationConfig?.maxOutputTokens, 100);
});

test("estimateInputTokens is positive and scales with content", () => {
  const small = estimateInputTokens({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const big = estimateInputTokens({ model: "m", messages: [{ role: "user", content: "x".repeat(4000) }] });
  assert.ok(small >= 16);
  assert.ok(big > small);
});

test("geminiToOpenAI maps usage and text", () => {
  const o = geminiToOpenAI(
    {
      candidates: [{ content: { parts: [{ text: "hello there" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    },
    "gemini-3.5-flash",
  );
  assert.equal(o.choices[0].message.content, "hello there");
  assert.equal(o.choices[0].finish_reason, "stop");
  assert.equal(o.usage.prompt_tokens, 10);
});

test("SSE line parsing and chunk mapping", () => {
  const g = parseGeminiSseLine('data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}');
  assert.ok(g);
  const chunk = geminiChunkToOpenAI(g!, "m", "id1", 1, false);
  const choice = (chunk as { choices: Array<{ delta: { content?: string } }> }).choices[0];
  assert.equal(choice.delta.content, "a");
  assert.equal(parseGeminiSseLine("data: [DONE]"), null);
  assert.equal(parseGeminiSseLine(""), null);
});

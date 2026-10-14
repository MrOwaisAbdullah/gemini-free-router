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

// 1x1 transparent PNG as a base64 data URI (the exact shape OpenAI vision
// clients send; lib/image_vision.py builds the same `data:<mime>;base64,...`).
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URI_PNG = `data:image/png;base64,${PNG_1PX}`;

test("openaiToGemini translates image_url data URI to inline_data", () => {
  const g = openaiToGemini({
    model: "auto",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image_url", image_url: { url: DATA_URI_PNG } },
        ],
      },
    ],
  });
  const parts = g.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, "describe");
  assert.deepEqual(parts[1].inline_data, { mime_type: "image/png", data: PNG_1PX });
});

test("openaiToGemini translates remote image URLs to file_data with mime from extension", () => {
  const g = openaiToGemini({
    model: "auto",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://cdn.example.com/hero.jpg?w=800" } },
          { type: "image_url", image_url: { url: "https://cdn.example.com/pic" } },
        ],
      },
    ],
  });
  const parts = g.contents[0].parts;
  assert.deepEqual(parts[0].file_data, { file_uri: "https://cdn.example.com/hero.jpg?w=800", mime_type: "image/jpeg" });
  // no extension → file_data without mime_type (Gemini accepts it, live-verified)
  assert.deepEqual(parts[1].file_data, { file_uri: "https://cdn.example.com/pic" });
});

test("image in system message lands in systemInstruction (Gemini-accepted)", () => {
  const g = openaiToGemini({
    model: "auto",
    messages: [
      { role: "system", content: [{ type: "image_url", image_url: { url: DATA_URI_PNG } }] },
      { role: "user", content: "ok?" },
    ],
  });
  assert.equal(g.systemInstruction?.parts.length, 1);
  assert.equal(g.systemInstruction?.parts[0].inline_data?.mime_type, "image/png");
});

test("estimateInputTokens counts images at the measured flat ~1100 tokens", () => {
  const textOnly = estimateInputTokens({ model: "m", messages: [{ role: "user", content: "hi" }] });
  const withImage = estimateInputTokens({
    model: "m",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: DATA_URI_PNG } },
        ],
      },
    ],
  });
  // Live-measured media tokens are ~1090 regardless of image size (512x512
  // through 1536x1024), so the estimate must be flat, not byte-proportional —
  // a 1.19MB image costs 1086 tokens, not the ~24K a bytes/4 math implies.
  assert.ok(withImage - textOnly >= 1000, `image delta ${withImage - textOnly} should be ~1100`);
  assert.ok(withImage - textOnly <= 1300, `image delta ${withImage - textOnly} should be ~1100`);
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

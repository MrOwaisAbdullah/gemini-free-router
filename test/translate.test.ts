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

// --- Function calling (v0.4.0): OpenAI tools/tool_calls ↔ Gemini          ---
// functionDeclarations/functionCall/functionResponse. The contentfte CI      //
// failure (2026-10-15 research/brief stages, empty agent output) was this    //
// vocabulary being silently dropped (dev-log §1.21).                          //

const KEYWORD_TOOL = {
  type: "function",
  function: {
    name: "get_keyword_tool",
    description: "Read/write access to ContentSpark_Keywords",
    parameters: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    },
  },
};

test("openaiToGemini translates tools to functionDeclarations (non-function tools skipped)", () => {
  const g = openaiToGemini({
    model: "auto",
    messages: [{ role: "user", content: "next keyword?" }],
    tools: [KEYWORD_TOOL, { type: "web_search" }],
  });
  assert.equal(g.tools?.length, 1);
  const decls = g.tools?.[0].functionDeclarations;
  assert.equal(decls?.length, 1);
  assert.equal(decls?.[0].name, "get_keyword_tool");
  assert.equal(decls?.[0].description, "Read/write access to ContentSpark_Keywords");
  assert.deepEqual(decls?.[0].parameters?.required, ["action"]);
  // no tool_choice → no toolConfig (Gemini's AUTO is the default)
  assert.equal(g.toolConfig, undefined);
});

test("tool_choice maps to Gemini toolConfig; none omits declarations", () => {
  const base = { model: "auto", messages: [{ role: "user" as const, content: "x" }], tools: [KEYWORD_TOOL] };
  assert.deepEqual(openaiToGemini({ ...base, tool_choice: "required" }).toolConfig, {
    functionCallingConfig: { mode: "ANY" },
  });
  assert.deepEqual(
    openaiToGemini({ ...base, tool_choice: { type: "function", function: { name: "get_keyword_tool" } } })
      .toolConfig,
    { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_keyword_tool"] } },
  );
  assert.equal(openaiToGemini({ ...base, tool_choice: "auto" }).toolConfig, undefined);
  const none = openaiToGemini({ ...base, tool_choice: "none" });
  assert.equal(none.tools, undefined);
  assert.equal(none.toolConfig, undefined);
});

test("assistant tool_calls and role:tool results map to functionCall/functionResponse", () => {
  const g = openaiToGemini({
    model: "auto",
    messages: [
      { role: "user", content: "Check the Keyword sheet" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: {
              name: "get_keyword_tool",
              arguments: '{"action":"read","worksheet_name":"ContentSpark_Keywords"}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_abc", content: '{"status":"ok","topic":"AI tools"}' },
      { role: "assistant", content: "done" },
    ],
  });
  // content:null + tool_calls → functionCall only, no empty text part
  assert.equal(g.contents[0].role, "user");
  assert.deepEqual(g.contents[1].parts, [
    {
      functionCall: {
        name: "get_keyword_tool",
        args: { action: "read", worksheet_name: "ContentSpark_Keywords" },
      },
    },
  ]);
  // role:"tool" → user turn; name recovered from the id via the prior turn
  assert.equal(g.contents[2].role, "user");
  assert.deepEqual(g.contents[2].parts, [
    { functionResponse: { name: "get_keyword_tool", response: { status: "ok", topic: "AI tools" } } },
  ]);
  assert.equal(g.contents[3].role, "model");
});

test("non-JSON tool output wraps in {output} (Gemini's Struct convention)", () => {
  const g = openaiToGemini({
    model: "auto",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "t1", content: "plain text result" },
    ],
  });
  assert.deepEqual(g.contents[1].parts, [
    { functionResponse: { name: "f", response: { output: "plain text result" } } },
  ]);
});

test("geminiToOpenAI maps functionCall parts to tool_calls with finish tool_calls", () => {
  const o = geminiToOpenAI(
    {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "get_keyword_tool", args: { action: "read" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 },
    },
    "gemini-3.1-flash-lite",
  );
  const msg = o.choices[0].message as {
    content: string | null;
    tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
  };
  assert.equal(msg.content, "");
  assert.equal(o.choices[0].finish_reason, "tool_calls");
  assert.equal(msg.tool_calls?.length, 1);
  assert.match(msg.tool_calls![0].id, /^call_/);
  assert.equal(msg.tool_calls![0].type, "function");
  assert.equal(msg.tool_calls![0].function.name, "get_keyword_tool");
  assert.deepEqual(JSON.parse(msg.tool_calls![0].function.arguments), { action: "read" });
  assert.equal(o.usage.prompt_tokens, 20);
});

test("plain text responses keep finish stop and no tool_calls (regression)", () => {
  const o = geminiToOpenAI(
    { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }] },
    "m",
  );
  assert.equal(o.choices[0].finish_reason, "stop");
  assert.equal(
    (o.choices[0].message as { tool_calls?: unknown }).tool_calls,
    undefined,
  );
});

test("chunk mapping carries functionCall deltas with index and finish tool_calls", () => {
  const chunk = geminiChunkToOpenAI(
    {
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "f", args: { x: 1 } } }] },
          finishReason: "STOP",
        },
      ],
    },
    "m",
    "id2",
    1,
    false,
  );
  const choice = (
    chunk as {
      choices: Array<{
        delta: {
          tool_calls?: Array<{ index: number; id: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string | null;
      }>;
    }
  ).choices[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.equal(choice.delta.tool_calls?.length, 1);
  assert.equal(choice.delta.tool_calls![0].index, 0);
  assert.match(choice.delta.tool_calls![0].id, /^call_/);
  assert.equal(choice.delta.tool_calls![0].function.name, "f");
  assert.deepEqual(JSON.parse(choice.delta.tool_calls![0].function.arguments), { x: 1 });
});

test("Gemini thoughtSignature + call id round-trip on the client's echo (Gemini 3)", () => {
  // Gemini 3 responds with {functionCall:{...,id}, thoughtSignature} and 400s
  // a replay missing the signature — the router memoizes its own generated
  // tool_call id → {geminiId, signature} and re-attaches both on replay.
  const o = geminiToOpenAI(
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "f", args: { a: 1 }, id: "call_479006" },
                thoughtSignature: "SIG123",
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    },
    "m",
  );
  const msg = o.choices[0].message as {
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
  assert.equal(msg.tool_calls?.length, 1);
  const echoedId = msg.tool_calls![0].id;

  const g = openaiToGemini({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: echoedId, type: "function", function: { name: "f", arguments: '{"a":1}' } },
        ],
      },
      { role: "tool", tool_call_id: echoedId, content: '{"ok":true}' },
    ],
  });
  const modelPart = g.contents[1].parts[0];
  assert.deepEqual(modelPart.functionCall, { name: "f", args: { a: 1 }, id: "call_479006" });
  assert.equal(modelPart.thoughtSignature, "SIG123");
  assert.deepEqual(g.contents[2].parts, [
    { functionResponse: { name: "f", response: { ok: true } } },
  ]);
});

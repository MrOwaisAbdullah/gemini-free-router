// Fake Gemini upstream for the local smoke test (see docs/dev-log.md §1.14.8):
// always answers an ambiguous 429 so forensics falls into the jittered
// exponential-backoff path. `node smoke-upstream.mjs` then run the router with
// smoke-config.json (gemini.base_url → http://127.0.0.1:9999/v1beta).
import { createServer } from "node:http";

const body = JSON.stringify({
  error: {
    code: 429,
    message: "The system is busy and cannot process the request right now. Please try again later.",
    status: "RESOURCE_EXHAUSTED",
  },
});

createServer((_req, res) => {
  res.writeHead(429, { "content-type": "application/json" });
  res.end(body);
}).listen(9999, "127.0.0.1", () => process.stdout.write("fake Gemini upstream on 127.0.0.1:9999\n"));

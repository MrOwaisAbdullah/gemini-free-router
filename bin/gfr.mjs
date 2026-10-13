#!/usr/bin/env node
// Requires Node >= 22.18 (engines) or Bun. Runs the compiled output — Node
// refuses to strip TypeScript from files under node_modules, so `npm pack`
// builds dist/ via the prepack script.
import "../dist/cli.js";

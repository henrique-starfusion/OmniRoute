import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveProviderAlias as pureResolve } from "../../open-sse/services/providerAlias.ts";
import { resolveProviderAlias as modelResolve } from "../../open-sse/services/model.ts";

// controlCenter.ts is imported by ComboControlCenterClient.tsx ("use client").
// Importing open-sse/services/model.ts there pulls DB/playwright/sharp into the
// browser bundle and breaks `next build` (Turbopack: Can't resolve 'fs').
test("controlCenter.ts does not import server-only model.ts", () => {
  const src = readFileSync(join(process.cwd(), "src/lib/combos/controlCenter.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["'][^"']*services\/model(\.ts)?["']/);
  // The open-sse provider registry pulls node:fs into the browser chunk too.
  assert.doesNotMatch(src, /from\s+["'][^"']*(providerAlias|providerModels|providerRegistry)/);
});

test("providerAlias.ts has no runtime/DB imports", () => {
  const src = readFileSync(join(process.cwd(), "open-sse/services/providerAlias.ts"), "utf8");
  const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["../config/providerModels.ts"]);
});

test("model.ts re-exports the same resolveProviderAlias", () => {
  assert.equal(modelResolve, pureResolve);
  assert.equal(pureResolve("oc"), "opencode");
  assert.equal(pureResolve("aq"), "amazon-q");
  assert.equal(pureResolve(null), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const gracefulShutdownPath = path.resolve(testDir, "../../src/lib/gracefulShutdown.ts");
const gracefulShutdownSource = fs.readFileSync(gracefulShutdownPath, "utf8");

test("graceful shutdown uses process-wide background-service hooks", () => {
  assert.doesNotMatch(
    gracefulShutdownSource,
    /(?:from\s+|import\s*\()(["'])@\/lib\/jobs\/memoryReindexJob\1/,
    "gracefulShutdown.ts must not import memoryReindexJob directly"
  );
  assert.doesNotMatch(
    gracefulShutdownSource,
    /(?:from\s+|import\s*\()(["'])@\/lib\/obsidian\/syncServer\1/,
    "gracefulShutdown.ts must not import obsidian syncServer directly"
  );
  assert.match(
    gracefulShutdownSource,
    /(?:globalThis\.)?__omnirouteStopMemoryReindexJob\?\.\s*\(/,
    "gracefulShutdown.ts must invoke the optional memory reindex shutdown hook"
  );
  assert.match(
    gracefulShutdownSource,
    /(?:globalThis\.)?__omnirouteStopObsidianSyncServer\?\.\s*\(/,
    "gracefulShutdown.ts must invoke the optional Obsidian sync shutdown hook"
  );
});

import test from "node:test";
import assert from "node:assert/strict";

process.env.MEMORY_AUTO_REINDEX_ENABLED = "false";
const job = await import("../../src/lib/jobs/memoryReindexJob.ts");

test.afterEach(async () => {
  await job.stopMemoryReindexJob();
  process.env.MEMORY_AUTO_REINDEX_ENABLED = "false";
});

test("auto reindex is opt-in", () => {
  const status = job.startMemoryReindexJob();
  assert.equal(status.enabled, false);
  assert.equal(status.phase, "disabled");
});

test("manual triggers share one in-flight batch", async () => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  job._setMemoryReindexJobDeps({
    getPending: () => (calls === 0 ? 1 : 0),
    runBatch: async () => {
      calls++;
      await blocked;
      return { processed: 1, errors: 0 };
    },
  });
  job.triggerMemoryReindexJob();
  job.triggerMemoryReindexJob();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await job.stopMemoryReindexJob();
});

/**
 * Process-wide memory reindex scheduler and shared manual worker.
 */

import { getReindexPending, runReindexBatch } from "@/lib/memory/reindex";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { logger } from "@omniroute/open-sse/utils/logger.ts";

const log = logger("MEMORY_REINDEX_JOB");
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_INTERVAL_MS = 300_000;
const MIN_BACKOFF_MS = 1_000;

type BatchResult = { processed: number; errors: number };
type JobDeps = {
  getPending: () => number;
  runBatch: (limit: number) => Promise<BatchResult>;
};

declare global {
  var __omnirouteStopMemoryReindexJob: (() => Promise<void>) | undefined;
}

export type MemoryReindexJobStatus = {
  enabled: boolean;
  phase: "disabled" | "idle" | "running" | "stopped";
  pending: number;
};

let deps: JobDeps = { getPending: getReindexPending, runBatch: runReindexBatch };
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | undefined;
let stopped = false;
let autoEnabled = false;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isEnabled(): boolean {
  return process.env.MEMORY_AUTO_REINDEX_ENABLED?.toLowerCase() === "true";
}

function batchSize(): number {
  return positiveInteger(process.env.MEMORY_AUTO_REINDEX_BATCH_SIZE, DEFAULT_BATCH_SIZE);
}

function intervalMs(): number {
  return positiveInteger(process.env.MEMORY_AUTO_REINDEX_INTERVAL_MS, DEFAULT_INTERVAL_MS);
}

function schedule(delayMs: number): void {
  if (stopped || !autoEnabled) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void triggerMemoryReindexJob();
  }, delayMs);
  timer.unref?.();
}

async function drain(): Promise<void> {
  let retry = false;
  try {
    while (!stopped && deps.getPending() > 0) {
      const result = await deps.runBatch(batchSize());
      if (result.processed <= 0) {
        retry = true;
        break;
      }
    }
  } catch (err: unknown) {
    retry = true;
    log.warn("memory.reindex.job.fail", {
      error: sanitizeErrorMessage(err instanceof Error ? err.message : String(err)),
    });
  } finally {
    running = undefined;
    if (!stopped && autoEnabled)
      schedule(retry ? Math.min(intervalMs(), MIN_BACKOFF_MS) : intervalMs());
  }
}

export function triggerMemoryReindexJob(): Promise<void> {
  globalThis.__omnirouteStopMemoryReindexJob = stopMemoryReindexJob;
  if (running) return running;
  stopped = false;
  running = drain();
  return running;
}

export function startMemoryReindexJob(): MemoryReindexJobStatus {
  autoEnabled = isEnabled();
  stopped = false;
  const pending = deps.getPending();
  if (!autoEnabled) return { enabled: false, phase: "disabled", pending };
  void triggerMemoryReindexJob();
  return { enabled: true, phase: running ? "running" : "idle", pending };
}

export async function stopMemoryReindexJob(): Promise<void> {
  stopped = true;
  autoEnabled = false;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  try {
    await running;
  } finally {
    if (globalThis.__omnirouteStopMemoryReindexJob === stopMemoryReindexJob) {
      globalThis.__omnirouteStopMemoryReindexJob = undefined;
    }
  }
}

globalThis.__omnirouteStopMemoryReindexJob = stopMemoryReindexJob;

export function _setMemoryReindexJobDeps(overrides: Partial<JobDeps>): void {
  deps = { ...deps, ...overrides };
}

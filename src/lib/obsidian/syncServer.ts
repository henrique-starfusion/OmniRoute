import { createHash, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { copyFile, lstat, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { sanitizeErrorMessage } from "../../../open-sse/utils/errorSanitization.ts";

const MAX_BODY_BYTES = 64 * 1024;
const CONFLICT_MARKER = ".conflict-";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 27781;

type Resolution = "local" | "remote" | "keep-both";

export type ObsidianSyncResult = {
  ok: true;
  pulled: number;
  pushed: number;
  deleted: number;
  conflicts: number;
};

export type ObsidianSyncServerOptions = {
  host?: string;
  port?: number;
  token: string;
  vaultPath: string;
};

export type ObsidianSyncServer = {
  readonly host: string;
  readonly port: number;
  readonly vaultPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type Conflict = { path: string; conflictPath: string; detectedAt: number };

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "RequestError";
  }
}

declare global {
  var __omnirouteObsidianSyncServer: ObsidianSyncServer | undefined;
  var __omnirouteStopObsidianSyncServer: (() => Promise<boolean>) | undefined;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(encoded),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, {
    error: { message: sanitizeErrorMessage(message) || "Request failed" },
  });
}

function tokenDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function isAuthorized(request: IncomingMessage, expectedDigest: Buffer): boolean {
  const authorization = request.headers.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return timingSafeEqual(tokenDigest(match?.[1]?.trim() ?? ""), expectedDigest);
}

async function scanVault(vaultPath: string): Promise<{ files: string[]; conflicts: Conflict[] }> {
  const files: string[] = [];
  const conflicts: Conflict[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;

      const path = relative(vaultPath, absolute).split(sep).join("/");
      const marker = path.lastIndexOf(CONFLICT_MARKER);
      if (marker > path.lastIndexOf("/") && marker + CONFLICT_MARKER.length < path.length) {
        const fileStats = await lstat(absolute);
        conflicts.push({
          path: path.slice(0, marker),
          conflictPath: path,
          detectedAt: fileStats.mtimeMs,
        });
      } else {
        files.push(path);
      }
    }
  }

  await visit(vaultPath);
  files.sort();
  conflicts.sort((left, right) => left.conflictPath.localeCompare(right.conflictPath));
  return { files, conflicts };
}

function safeCandidate(vaultPath: string, requestedPath: string): string | null {
  if (!requestedPath || requestedPath.includes("\0") || isAbsolute(requestedPath)) return null;
  const candidate = resolve(vaultPath, requestedPath);
  const relation = relative(vaultPath, candidate);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    return null;
  }
  return candidate;
}

async function remainsInsideVault(vaultPath: string, candidate: string): Promise<boolean> {
  const vaultRealPath = await realpath(vaultPath);
  let existingPath = candidate;
  while (existingPath !== vaultPath) {
    try {
      const stats = await lstat(existingPath);
      if (stats.isSymbolicLink()) return false;
      const resolvedPath = await realpath(existingPath);
      const relation = relative(vaultRealPath, resolvedPath);
      return (
        relation === "" ||
        (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
      );
    } catch {
      existingPath = dirname(existingPath);
    }
  }
  return true;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    request.resume();
    throw new RequestError(413, "Request body exceeds the 64 KiB limit");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RequestError(413, "Request body exceeds the 64 KiB limit");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "Request body must be valid JSON");
  }
}

function keepBothPath(conflictPath: string): string {
  const marker = conflictPath.indexOf(CONFLICT_MARKER);
  const canonical = conflictPath.slice(0, marker);
  const suffix = conflictPath
    .slice(marker + CONFLICT_MARKER.length)
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const extensionIndex = canonical.lastIndexOf(".");
  return extensionIndex > canonical.lastIndexOf("/")
    ? `${canonical.slice(0, extensionIndex)}.local-${suffix}${canonical.slice(extensionIndex)}`
    : `${canonical}.local-${suffix}`;
}

function withNumericSuffix(path: string, suffix: number): string {
  if (suffix === 0) return path;
  const extensionIndex = path.lastIndexOf(".");
  return extensionIndex > path.lastIndexOf("/")
    ? `${path.slice(0, extensionIndex)}-${suffix}${path.slice(extensionIndex)}`
    : `${path}-${suffix}`;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

async function preserveConflict(
  vaultPath: string,
  conflictAbsolute: string,
  conflictPath: string
): Promise<string> {
  const basePath = keepBothPath(conflictPath);
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const preservedPath = withNumericSuffix(basePath, suffix);
    const preservedAbsolute = safeCandidate(vaultPath, preservedPath);
    if (!preservedAbsolute || !(await remainsInsideVault(vaultPath, preservedAbsolute))) {
      throw new RequestError(400, "Invalid preserved path");
    }
    try {
      await copyFile(conflictAbsolute, preservedAbsolute, fsConstants.COPYFILE_EXCL);
      await unlink(conflictAbsolute);
      return preservedPath;
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new RequestError(409, "Unable to choose a unique preserved conflict path");
}

export function createObsidianSyncServer(options: ObsidianSyncServerOptions): ObsidianSyncServer {
  const host = options.host?.trim() || DEFAULT_HOST;
  const configuredPort = options.port ?? DEFAULT_PORT;
  const configuredVaultPath = resolve(options.vaultPath);
  const token = options.token.trim();
  if (!token) throw new Error("OBSIDIAN_SYNC_TOKEN is required");
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
    throw new Error("Obsidian sync server port must be between 0 and 65535");
  }
  const expectedDigest = tokenDigest(token);
  let boundPort = configuredPort;
  let server: Server | null = null;
  let startPromise: Promise<void> | null = null;
  let activeVaultPath = configuredVaultPath;
  let startedAt = 0;
  let lastSync: ObsidianSyncResult | null = null;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAuthorized(request, expectedDigest)) {
      sendError(response, 401, "Invalid or missing sync token");
      return;
    }

    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && path === "/vault/sync/status") {
      sendJson(response, 200, {
        running: server?.listening === true,
        uptime: startedAt === 0 ? 0 : Math.floor((Date.now() - startedAt) / 1000),
        port: boundPort,
        vaultName: basename(activeVaultPath),
        lastSync,
      });
      return;
    }

    if (request.method === "POST" && path === "/vault/sync/trigger") {
      const manifest = await scanVault(activeVaultPath);
      lastSync = {
        ok: true,
        pulled: 0,
        pushed: manifest.files.length,
        deleted: 0,
        conflicts: manifest.conflicts.length,
      };
      sendJson(response, 200, lastSync);
      return;
    }

    if (request.method === "GET" && path === "/vault/sync/conflicts") {
      sendJson(response, 200, { conflicts: (await scanVault(activeVaultPath)).conflicts });
      return;
    }

    if (request.method === "POST" && path === "/vault/sync/resolve") {
      const rawBody = await readBody(request);
      const body =
        typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody)
          ? (rawBody as Record<string, unknown>)
          : {};
      if (
        typeof body.path !== "string" ||
        typeof body.resolution !== "string" ||
        !["local", "remote", "keep-both"].includes(body.resolution)
      ) {
        sendError(response, 400, "Invalid conflict resolution request");
        return;
      }

      const canonical = safeCandidate(activeVaultPath, body.path);
      if (!canonical || !(await remainsInsideVault(activeVaultPath, canonical))) {
        sendError(response, 400, "Path must remain inside the configured vault");
        return;
      }

      const manifest = await scanVault(activeVaultPath);
      const normalizedPath = relative(activeVaultPath, canonical).split(sep).join("/");
      const matchingConflicts = manifest.conflicts.filter((item) => item.path === normalizedPath);
      if (matchingConflicts.length === 0) {
        sendError(response, 404, "Conflict not found");
        return;
      }
      if (matchingConflicts.length > 1) {
        sendError(response, 409, "Multiple conflict variants exist for this path");
        return;
      }
      const conflict = matchingConflicts[0];
      const conflictAbsolute = safeCandidate(activeVaultPath, conflict.conflictPath);
      if (!conflictAbsolute || !(await remainsInsideVault(activeVaultPath, conflictAbsolute))) {
        sendError(response, 400, "Path must remain inside the configured vault");
        return;
      }

      const resolution = body.resolution as Resolution;
      if (resolution !== "local") {
        try {
          const canonicalStats = await lstat(canonical);
          if (!canonicalStats.isFile()) {
            throw new RequestError(409, "Canonical conflict path is not a file");
          }
        } catch (error: unknown) {
          if (error instanceof RequestError) throw error;
          if (errorCode(error) === "ENOENT") {
            throw new RequestError(409, "Canonical conflict file does not exist");
          }
          throw error;
        }
      }
      let preservedPaths: string[] = [];
      if (resolution === "local") {
        await copyFile(conflictAbsolute, canonical);
        await unlink(conflictAbsolute);
      } else if (resolution === "remote") {
        await unlink(conflictAbsolute);
      } else {
        const preservedPath = await preserveConflict(
          activeVaultPath,
          conflictAbsolute,
          conflict.conflictPath
        );
        preservedPaths = [preservedPath];
      }
      sendJson(response, 200, {
        ok: true,
        result: { path: normalizedPath, resolution, preservedPaths },
      });
      return;
    }

    sendError(response, 404, "Route not found");
  }

  return {
    host,
    get port(): number {
      return boundPort;
    },
    vaultPath: configuredVaultPath,
    async start(): Promise<void> {
      if (server?.listening) return Promise.resolve();
      if (startPromise) return startPromise;
      activeVaultPath = await realpath(configuredVaultPath);
      const vaultStats = await lstat(activeVaultPath);
      if (!vaultStats.isDirectory()) {
        throw new Error("Configured Obsidian vault path is not a directory");
      }
      server = createServer((request, response) => {
        void handle(request, response).catch((error: unknown) => {
          const requestError = error instanceof RequestError ? error : null;
          if (!requestError) {
            console.warn(
              "[Obsidian Sync] Request failed:",
              sanitizeErrorMessage(error instanceof Error ? error.message : String(error))
            );
          }
          sendError(
            response,
            requestError?.status ?? 500,
            requestError?.message ?? "Obsidian sync request failed"
          );
        });
      });
      startPromise = new Promise<void>((resolveStart, reject) => {
        server!.once("error", reject);
        server!.listen(configuredPort, host, () => {
          server!.off("error", reject);
          const address = server!.address();
          if (address && typeof address === "object") boundPort = address.port;
          startedAt = Date.now();
          resolveStart();
        });
      })
        .catch((error: unknown) => {
          server = null;
          throw error;
        })
        .finally(() => {
          startPromise = null;
        });
      return startPromise;
    },
    async stop(): Promise<void> {
      const current = server;
      try {
        if (startPromise) await startPromise;
        if (!current?.listening) return;
        await new Promise<void>((resolveStop, reject) => {
          current.close((error) => (error ? reject(error) : resolveStop()));
          current.closeIdleConnections();
        });
      } finally {
        if (server === current) server = null;
        startedAt = 0;
      }
    },
  };
}

function enabledFromEnv(value: string | undefined): boolean {
  return value !== undefined && new Set(["1", "true", "yes", "on"]).has(value.trim().toLowerCase());
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function syncPortFromEnv(): number {
  const configured = nonEmptyEnv("OBSIDIAN_SYNC_PORT");
  if (!configured) return DEFAULT_PORT;
  if (!/^\d+$/.test(configured)) {
    throw new Error("OBSIDIAN_SYNC_PORT must be an integer between 1 and 65535");
  }
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("OBSIDIAN_SYNC_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export async function startObsidianSyncServer(): Promise<boolean> {
  globalThis.__omnirouteStopObsidianSyncServer = stopObsidianSyncServer;
  if (!enabledFromEnv(process.env.OBSIDIAN_SYNC_ENABLED)) return false;
  if (globalThis.__omnirouteObsidianSyncServer) {
    await globalThis.__omnirouteObsidianSyncServer.start();
    return true;
  }

  const token = nonEmptyEnv("OBSIDIAN_SYNC_TOKEN");
  if (!token) {
    throw new Error("OBSIDIAN_SYNC_TOKEN is required when OBSIDIAN_SYNC_ENABLED=true");
  }

  let vaultPath = nonEmptyEnv("OBSIDIAN_SYNC_VAULT_PATH");
  if (!vaultPath) {
    const { getObsidianVaultPath } = await import("@/lib/db/obsidian");
    vaultPath = getObsidianVaultPath() ?? undefined;
  }
  if (!vaultPath) {
    throw new Error(
      "OBSIDIAN_SYNC_VAULT_PATH or an Obsidian vault path in settings is required when sync is enabled"
    );
  }

  const instance = createObsidianSyncServer({
    host: nonEmptyEnv("OBSIDIAN_SYNC_HOST") ?? DEFAULT_HOST,
    port: syncPortFromEnv(),
    token,
    vaultPath,
  });
  globalThis.__omnirouteObsidianSyncServer = instance;
  try {
    await instance.start();
    return true;
  } catch (error: unknown) {
    if (globalThis.__omnirouteObsidianSyncServer === instance) {
      globalThis.__omnirouteObsidianSyncServer = undefined;
    }
    throw error;
  }
}

export const initObsidianSyncServer = startObsidianSyncServer;

export async function stopObsidianSyncServer(): Promise<boolean> {
  const instance = globalThis.__omnirouteObsidianSyncServer;
  try {
    if (!instance) return false;
    await instance.stop();
    return true;
  } finally {
    if (globalThis.__omnirouteObsidianSyncServer === instance) {
      globalThis.__omnirouteObsidianSyncServer = undefined;
    }
    if (globalThis.__omnirouteStopObsidianSyncServer === stopObsidianSyncServer) {
      globalThis.__omnirouteStopObsidianSyncServer = undefined;
    }
  }
}

globalThis.__omnirouteStopObsidianSyncServer = stopObsidianSyncServer;

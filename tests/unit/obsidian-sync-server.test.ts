import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createObsidianSyncServer,
  startObsidianSyncServer,
  stopObsidianSyncServer,
  type ObsidianSyncServer,
} from "../../src/lib/obsidian/syncServer.ts";
import { createSyncServerClient, getSyncToken } from "../../src/lib/obsidian/api.ts";

const roots: string[] = [];
const servers: ObsidianSyncServer[] = [];

async function fixture(): Promise<{ root: string; server: ObsidianSyncServer; url: string }> {
  const root = await mkdtemp(join(tmpdir(), "omniroute-obsidian-sync-"));
  roots.push(root);
  const server = createObsidianSyncServer({
    host: "127.0.0.1",
    port: 0,
    token: "dedicated-sync-token",
    vaultPath: root,
  });
  servers.push(server);
  await server.start();
  return { root, server, url: `http://127.0.0.1:${server.port}` };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function request(url: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      Authorization: "Bearer dedicated-sync-token",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

test("sync server rejects missing or incorrect dedicated token", async () => {
  const { url } = await fixture();
  assert.equal((await fetch(`${url}/vault/sync/status`)).status, 401);
  assert.equal(
    (
      await fetch(`${url}/vault/sync/status`, {
        headers: { Authorization: "Bearer obsidian-rest-token" },
      })
    ).status,
    401
  );
});

test("sync client uses dedicated token and OBSIDIAN_SYNC_SERVER_URL", async () => {
  const { url } = await fixture();
  const previousServerUrl = process.env.OBSIDIAN_SYNC_SERVER_URL;
  const previousSyncToken = process.env.OBSIDIAN_SYNC_TOKEN;
  const previousRestToken = process.env.OBSIDIAN_API_KEY;
  try {
    process.env.OBSIDIAN_SYNC_SERVER_URL = url;
    process.env.OBSIDIAN_API_KEY = "obsidian-rest-token";
    delete process.env.OBSIDIAN_SYNC_TOKEN;
    assert.equal(getSyncToken(), null);

    process.env.OBSIDIAN_SYNC_TOKEN = "dedicated-sync-token";
    assert.equal(getSyncToken(), "dedicated-sync-token");
    const status = await createSyncServerClient(getSyncToken()!).getStatus();
    assert.equal(status.running, true);
  } finally {
    if (previousServerUrl === undefined) delete process.env.OBSIDIAN_SYNC_SERVER_URL;
    else process.env.OBSIDIAN_SYNC_SERVER_URL = previousServerUrl;
    if (previousSyncToken === undefined) delete process.env.OBSIDIAN_SYNC_TOKEN;
    else process.env.OBSIDIAN_SYNC_TOKEN = previousSyncToken;
    if (previousRestToken === undefined) delete process.env.OBSIDIAN_API_KEY;
    else process.env.OBSIDIAN_API_KEY = previousRestToken;
  }
});

test("embedded startup is opt-in and requires its dedicated token", async () => {
  const previousEnabled = process.env.OBSIDIAN_SYNC_ENABLED;
  const previousToken = process.env.OBSIDIAN_SYNC_TOKEN;
  try {
    delete process.env.OBSIDIAN_SYNC_ENABLED;
    delete process.env.OBSIDIAN_SYNC_TOKEN;
    assert.equal(await startObsidianSyncServer(), false);

    process.env.OBSIDIAN_SYNC_ENABLED = "true";
    await assert.rejects(startObsidianSyncServer, /OBSIDIAN_SYNC_TOKEN/);
  } finally {
    await stopObsidianSyncServer();
    if (previousEnabled === undefined) delete process.env.OBSIDIAN_SYNC_ENABLED;
    else process.env.OBSIDIAN_SYNC_ENABLED = previousEnabled;
    if (previousToken === undefined) delete process.env.OBSIDIAN_SYNC_TOKEN;
    else process.env.OBSIDIAN_SYNC_TOKEN = previousToken;
  }
});

test("trigger scans a local manifest and status reports consistent counts", async () => {
  const { root, url } = await fixture();
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "one.md"), "one");
  await writeFile(join(root, "notes", "two.md.conflict-mobile"), "two local");

  const trigger = await request(url, "/vault/sync/trigger", { method: "POST" });
  assert.equal(trigger.status, 200);
  const result = (await trigger.json()) as Record<string, unknown>;
  assert.deepEqual(result, { ok: true, pulled: 0, pushed: 1, deleted: 0, conflicts: 1 });

  const status = await request(url, "/vault/sync/status");
  const body = (await status.json()) as { running: boolean; vaultName: string; lastSync: unknown };
  assert.equal(body.running, true);
  assert.equal(body.vaultName, root.split(/[\\/]/).at(-1));
  assert.deepEqual(body.lastSync, result);
});

test("conflicts lists .conflict-* files and local resolution replaces canonical", async () => {
  const { root, url } = await fixture();
  await writeFile(join(root, "note.md"), "remote");
  await writeFile(join(root, "note.md.conflict-mobile"), "local");

  const conflicts = await request(url, "/vault/sync/conflicts");
  const listed = (await conflicts.json()) as {
    conflicts: Array<{ path: string; conflictPath: string }>;
  };
  assert.equal(listed.conflicts.length, 1);
  assert.equal(listed.conflicts[0]?.path, "note.md");
  assert.equal(listed.conflicts[0]?.conflictPath, "note.md.conflict-mobile");

  const resolved = await request(url, "/vault/sync/resolve", {
    method: "POST",
    body: JSON.stringify({ path: "note.md", resolution: "local" }),
  });
  assert.equal(resolved.status, 200);
  assert.equal(await readFile(join(root, "note.md"), "utf8"), "local");
  assert.equal(
    (
      (await request(url, "/vault/sync/conflicts").then((r) => r.json())) as {
        conflicts: unknown[];
      }
    ).conflicts.length,
    0
  );
});

test("remote and keep-both resolutions have documented filesystem semantics", async () => {
  const { root, url } = await fixture();
  await writeFile(join(root, "remote.md"), "remote");
  await writeFile(join(root, "remote.md.conflict-phone"), "local");
  assert.equal(
    (
      await request(url, "/vault/sync/resolve", {
        method: "POST",
        body: JSON.stringify({ path: "remote.md", resolution: "remote" }),
      })
    ).status,
    200
  );
  assert.equal(await readFile(join(root, "remote.md"), "utf8"), "remote");

  await writeFile(join(root, "both.md"), "remote both");
  await writeFile(join(root, "both.md.conflict-phone"), "local both");
  const response = await request(url, "/vault/sync/resolve", {
    method: "POST",
    body: JSON.stringify({ path: "both.md", resolution: "keep-both" }),
  });
  const body = (await response.json()) as { result: { preservedPaths: string[] } };
  assert.equal(response.status, 200);
  assert.equal(await readFile(join(root, body.result.preservedPaths[0]!), "utf8"), "local both");
  assert.equal(await readFile(join(root, "both.md"), "utf8"), "remote both");
});

test("resolve rejects traversal and symlink escape", async (t) => {
  const { root, url } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "omniroute-obsidian-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "secret.md"), "secret");
  await writeFile(join(outside, "secret.md.conflict-phone"), "replacement");

  const traversal = await request(url, "/vault/sync/resolve", {
    method: "POST",
    body: JSON.stringify({ path: "../secret.md", resolution: "local" }),
  });
  assert.equal(traversal.status, 400);

  try {
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${String(error)}`);
    return;
  }
  const escaped = await request(url, "/vault/sync/resolve", {
    method: "POST",
    body: JSON.stringify({ path: "escape/secret.md", resolution: "local" }),
  });
  assert.equal(escaped.status, 400);
  assert.equal(await readFile(join(outside, "secret.md"), "utf8"), "secret");
});

test("resolve enforces the JSON body limit", async () => {
  const { url } = await fixture();
  const response = await request(url, "/vault/sync/resolve", {
    method: "POST",
    body: JSON.stringify({ path: "x".repeat(70_000), resolution: "remote" }),
  });
  assert.equal(response.status, 413);
});

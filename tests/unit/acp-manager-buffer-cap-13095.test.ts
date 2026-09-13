import test from "node:test";
import assert from "node:assert/strict";

const { AcpManager } = await import("../../src/lib/acp/manager.ts");
const { setCustomAgents } = await import("../../src/lib/acp/registry.ts");

const AGENT_ID = "buffer-cap-probe";
const CAP = 1_048_576;

/**
 * Spawn a node process that writes `bytes` of stdout (or stderr) and stays alive,
 * so the buffers can be inspected while the session is still running.
 */
function makeAgent(stream: "stdout" | "stderr", bytes: number) {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Buffer cap probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  const script = `
    const chunk = "x".repeat(64 * 1024);
    let written = 0;
    const target = ${bytes};
    while (written < target) {
      process.${stream}.write(chunk);
      written += chunk.length;
    }
    setInterval(() => {}, 1000);
  `;
  return ["-e", script];
}

async function waitForOutput(session: { stdoutBuffer: string; stderrBuffer: string }) {
  // Give the child time to flush everything it intends to write.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (session.stdoutBuffer.length > CAP / 2 || session.stderrBuffer.length > CAP / 2) break;
  }
  await new Promise((r) => setTimeout(r, 300));
}

test("stdout buffer stays bounded when an agent floods it (#13095)", async () => {
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, makeAgent("stdout", 4 * CAP));
  try {
    await waitForOutput(session);
    assert.ok(
      session.stdoutBuffer.length > 0,
      "precondition: the probe agent must have written something"
    );
    assert.ok(
      session.stdoutBuffer.length <= CAP,
      `stdoutBuffer grew to ${session.stdoutBuffer.length} chars, above the ${CAP} cap`
    );
  } finally {
    mgr.kill(session.id);
  }
});

test("stderr buffer stays bounded when an agent floods it (#13095)", async () => {
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, makeAgent("stderr", 4 * CAP));
  try {
    await waitForOutput(session);
    assert.ok(
      session.stderrBuffer.length > 0,
      "precondition: the probe agent must have written something"
    );
    assert.ok(
      session.stderrBuffer.length <= CAP,
      `stderrBuffer grew to ${session.stderrBuffer.length} chars, above the ${CAP} cap`
    );
  } finally {
    mgr.kill(session.id);
  }
});

test("truncation keeps the most recent output, not the oldest (#13095)", async () => {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Buffer cap probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  const script = `
    const chunk = "x".repeat(64 * 1024);
    let written = 0;
    while (written < ${2 * CAP}) { process.stdout.write(chunk); written += chunk.length; }
    process.stdout.write("FINAL-MARKER");
    setInterval(() => {}, 1000);
  `;
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, ["-e", script]);
  try {
    await waitForOutput(session);
    // The tail is the part callers use: sendPrompt resolves with stdout, and
    // stderr is read for diagnostics after a failure.
    assert.ok(
      session.stdoutBuffer.endsWith("FINAL-MARKER"),
      "the newest output must survive truncation"
    );
    assert.ok(session.stdoutBuffer.length <= CAP, "buffer must still respect the cap");
  } finally {
    mgr.kill(session.id);
  }
});

test("stderr is reset between prompts so diagnostics are per-prompt (#13095)", async () => {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Buffer cap probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  // Echoes stdin back on stdout, and writes a fixed line to stderr per prompt.
  const script = `
    process.stdin.on("data", (d) => {
      process.stderr.write("warn:" + d.toString().trim() + "\\n");
      process.stdout.write("ok\\n");
    });
    setInterval(() => {}, 1000);
  `;
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, ["-e", script]);
  try {
    await mgr.sendPrompt(session.id, "first", 6000);
    await mgr.sendPrompt(session.id, "second", 6000);
    assert.ok(
      !session.stderrBuffer.includes("warn:first"),
      `stderr from an earlier prompt leaked into the next one: ${JSON.stringify(session.stderrBuffer)}`
    );
    assert.ok(session.stderrBuffer.includes("warn:second"), "current prompt's stderr must be kept");
  } finally {
    mgr.kill(session.id);
  }
});

// #long-context: a prompt larger than the writable highWaterMark must be fully flushed
// before sendPrompt starts its response idle window. Slow readers otherwise receive only
// a prefix while the caller resolves as if the whole payload had been delivered.
test("sendPrompt honors stdin backpressure for long prompts", async () => {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Slow stdin probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  const script = `
    let received = 0;
    process.stdin.on("data", (chunk) => {
      process.stdin.pause();
      received += chunk.length;
      setTimeout(() => {
        process.stdout.write(String(received) + "\\n");
        process.stdin.resume();
      }, 5);
    });
    setInterval(() => {}, 1000);
  `;
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, ["-e", script]);
  const prompt = "x".repeat(2 * 1024 * 1024);
  try {
    const output = await mgr.sendPrompt(session.id, prompt, 15_000);
    const counts = [...output.matchAll(/\d+/g)].map((match) => Number(match[0]));
    assert.equal(Math.max(...counts), Buffer.byteLength(prompt + "\n"));
  } finally {
    mgr.kill(session.id);
  }
});

test("sendPrompt remembers stdout emitted while stdin is still writing", async () => {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Early stdout probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  const script = `
    process.stdout.write("EARLY-OUTPUT\\n");
    process.stdin.pause();
    setTimeout(() => {
      process.stdin.on("data", () => {});
      process.stdin.resume();
    }, 200);
    setInterval(() => {}, 1000);
  `;
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, ["-e", script]);
  try {
    const output = await mgr.sendPrompt(session.id, "x".repeat(2 * 1024 * 1024), 4000);
    assert.match(output, /EARLY-OUTPUT/);
  } finally {
    mgr.kill(session.id);
  }
});

test("sendPrompt resolves buffered stdout when the agent exits during write", async () => {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Early exit probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  const script = `
    process.stdin.pause();
    process.stdout.write("x".repeat(256 * 1024));
    process.stdout.write("BEFORE-EXIT\\n");
    process.exit(0);
  `;
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, ["-e", script]);

  const output = await mgr.sendPrompt(session.id, "x".repeat(2 * 1024 * 1024), 3000);
  assert.ok(output.endsWith("BEFORE-EXIT\n"), "stdout must drain before sendPrompt resolves");
  assert.equal(mgr.listenerCount("stdout"), 0);
  assert.equal(mgr.listenerCount("exit"), 0);
});

test("sendPrompt timeout includes a blocked stdin write", async () => {
  setCustomAgents([
    {
      id: AGENT_ID,
      name: "Blocked stdin probe",
      binary: process.execPath,
      acpSpawnable: true,
    },
  ]);
  const mgr = new AcpManager();
  const session = mgr.spawn(AGENT_ID, process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const startedAt = Date.now();
  await assert.rejects(
    () => mgr.sendPrompt(session.id, "x".repeat(2 * 1024 * 1024), 100),
    /ACP timeout after 100ms/
  );
  assert.ok(Date.now() - startedAt < 1500, "timeout must not wait for stdin.write callback");
  assert.equal(mgr.listenerCount("stdout"), 0);
  assert.equal(mgr.listenerCount("exit"), 0);
  assert.equal(session.process.stdin?.listenerCount("error"), 0);
  assert.equal(mgr.getSession(session.id), undefined, "timed-out session must be removed");
  assert.ok(session.process.killed, "timed-out session must be terminated");
});

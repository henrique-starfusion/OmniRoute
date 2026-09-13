/**
 * ACP (Agent Client Protocol) — Process Spawner & Manager
 *
 * Spawns CLI agents as child processes and manages their lifecycle.
 * Communication happens via stdin/stdout (JSON-RPC style) or piped HTTP.
 *
 * This module provides a "CLI-as-backend" transport: instead of intercepting
 * HTTP API calls, OmniRoute spawns the CLI directly and feeds prompts through
 * its native interface.
 */

import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import { hasRegisteredAgent } from "./registry";

export interface AcpSession {
  /** Unique session ID */
  id: string;
  /** Agent ID (e.g., "codex", "claude") */
  agentId: string;
  /** Child process handle */
  process: ChildProcess;
  /** Whether the process is alive */
  alive: boolean;
  /** Accumulated stdout buffer */
  stdoutBuffer: string;
  /** Accumulated stderr buffer */
  stderrBuffer: string;
  /** Created timestamp */
  createdAt: Date;
}

/**
 * Upper bound for each per-session output buffer.
 *
 * Both buffers grow on every chunk a CLI agent writes and are only reset when
 * the next prompt starts, so a chatty or looping agent can grow them without
 * limit while the session stays alive. 1 MiB is far above a realistic agent
 * response while keeping a stuck session's footprint bounded.
 */
const MAX_BUFFER_CHARS = 1_048_576;

const TRUNCATION_NOTICE = "\n[...output truncated...]\n";

/**
 * Append to a buffer, keeping the most recent output when the cap is exceeded.
 *
 * The tail is what callers care about: `sendPrompt` resolves with the stdout
 * collected since the prompt was written, and stderr is read for diagnostics
 * after a failure. Dropping from the front keeps both useful.
 */
function appendCapped(buffer: string, chunk: string): string {
  const combined = buffer + chunk;
  if (combined.length <= MAX_BUFFER_CHARS) return combined;

  const keep = MAX_BUFFER_CHARS - TRUNCATION_NOTICE.length;
  if (keep <= 0) return combined.slice(-MAX_BUFFER_CHARS);
  return TRUNCATION_NOTICE + combined.slice(-keep);
}

/**
 * ACP Session Manager
 *
 * Manages the lifecycle of CLI agent processes.
 * Each session represents one running CLI agent instance.
 */
export class AcpManager extends EventEmitter {
  private sessions: Map<string, AcpSession> = new Map();

  /**
   * Spawn a new CLI agent process.
   */
  spawn(
    agentId: string,
    binary: string,
    args: string[] = [],
    env: Record<string, string> = {}
  ): AcpSession {
    const normalizedAgentId = String(agentId || "")
      .trim()
      .toLowerCase();
    if (!hasRegisteredAgent(normalizedAgentId)) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Keep session ids and telemetry stable when a caller uses a registry
    // alias/custom spelling. The registry remains the source of truth for
    // which ACP-capable IDs may be spawned.
    agentId = normalizedAgentId;

    const sessionId = `acp-${agentId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      shell: false,
    });

    const session: AcpSession = {
      id: sessionId,
      agentId,
      process: child,
      alive: true,
      stdoutBuffer: "",
      stderrBuffer: "",
      createdAt: new Date(),
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      session.stdoutBuffer = appendCapped(session.stdoutBuffer, chunk.toString());
      this.emit("stdout", { sessionId, data: chunk.toString() });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      session.stderrBuffer = appendCapped(session.stderrBuffer, chunk.toString());
      this.emit("stderr", { sessionId, data: chunk.toString() });
    });

    child.on("close", (code, signal) => {
      session.alive = false;
      // Only kill() used to remove entries, so any agent that exited on its own
      // stayed in the map forever. getActiveSessions() filters on `alive`, which
      // hid the growth from callers.
      this.sessions.delete(sessionId);
      this.emit("exit", { sessionId, code, signal });
    });

    child.on("error", (err) => {
      session.alive = false;
      this.emit("error", { sessionId, error: err });
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Send input to a running session's stdin.
   */
  sendInput(sessionId: string, input: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.alive || !session.process.stdin?.writable) return false;

    session.process.stdin.write(input);
    return true;
  }

  /**
   * Send a prompt to a CLI agent and collect the response.
   * This is a higher-level method that handles the send/receive cycle.
   */
  async sendPrompt(sessionId: string, prompt: string, timeoutMs: number = 120000): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session?.alive) throw new Error(`Session ${sessionId} is not alive`);

    session.stdoutBuffer = "";
    session.stderrBuffer = "";

    return new Promise((resolve, reject) => {
      const stdin = session.process.stdin;
      if (!stdin?.writable) {
        reject(new Error(`Session ${session.id} is not accepting input`));
        return;
      }

      let settled = false;
      let writeComplete = false;
      let receivedOutput = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let writeError: Error | undefined;

      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearTimeout(idleTimer);
        this.removeListener("stdout", onData);
        this.removeListener("exit", onExit);
        stdin.removeListener("error", onWriteError);
        if (!writeComplete) stdin.destroy();
      };
      const settle = (finish: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        finish();
      };
      const armIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          settle(() => resolve(session.stdoutBuffer));
        }, 2000);
      };
      const onData = ({ sessionId: sid }: { sessionId: string }) => {
        if (sid !== sessionId) return;
        receivedOutput = true;
        if (writeComplete) armIdleTimer();
      };
      const onExit = ({ sessionId: sid }: { sessionId: string }) => {
        if (sid !== sessionId) return;
        if (writeError && !session.stdoutBuffer) {
          settle(() => reject(writeError));
          return;
        }
        settle(() => resolve(session.stdoutBuffer));
      };
      const rejectWrite = (error: Error) => {
        if (settled || writeError) return;
        writeError = error;
        if (session.process.exitCode === null) this.kill(sessionId);
      };
      const onWriteError = (error: Error) => rejectWrite(error);
      const timeoutTimer = setTimeout(() => {
        if (!writeComplete) this.kill(sessionId);
        settle(() => reject(new Error(`ACP timeout after ${timeoutMs}ms`)));
      }, timeoutMs);

      this.on("stdout", onData);
      this.on("exit", onExit);
      stdin.on("error", onWriteError);

      try {
        stdin.write(prompt + "\n", (error?: Error | null) => {
          if (settled) return;
          if (error) {
            rejectWrite(error);
            return;
          }
          writeComplete = true;
          stdin.removeListener("error", onWriteError);
          if (receivedOutput) armIdleTimer();
        });
      } catch (error) {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  /**
   * Kill a session and clean up.
   */
  kill(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.alive) {
      session.process.kill("SIGTERM");
      // Force kill after 5s
      setTimeout(() => {
        if (session.alive) {
          session.process.kill("SIGKILL");
        }
      }, 5000);
    }

    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): AcpSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.alive);
  }

  /**
   * Get a specific session.
   */
  getSession(sessionId: string): AcpSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Kill all sessions.
   */
  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }
}

// Singleton manager instance
export const acpManager = new AcpManager();

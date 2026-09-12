import { startNgrokTunnel, type NgrokTunnelStatus } from "@/lib/ngrokTunnel";

/**
 * Opt-in boot auto-start for the ngrok tunnel (#13xxx).
 *
 * Before this, `NGROK_AUTHTOKEN` alone only moved the tunnel's reported phase
 * from `needs_auth` to `stopped` ("ready to start") — the tunnel itself was
 * ALWAYS started by hand, from the dashboard's "Iniciar Túnel" button
 * (POST /api/tunnels/ngrok). That makes a container deployment useless as a
 * remote endpoint until a human opens the UI, which defeats the point of
 * baking the token into the image/compose env.
 *
 * The gate is deliberately DOUBLE opt-in — token present AND
 * `OMNIROUTE_NGROK_AUTOSTART` truthy. Publishing the proxy on a public ngrok
 * URL is a security-relevant action, so merely having a token configured
 * (e.g. for manual, occasional use) must never be enough to expose the
 * instance to the internet on every boot.
 *
 * Never throws: startNgrokTunnel() already swallows its own failures and
 * reports them via `phase: "error"` + `lastError`, and the caller in
 * instrumentation-node.ts treats tunnel startup as non-fatal.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** `true` when both the authtoken and the explicit opt-in flag are present. */
export function isNgrokAutoStartEnabled(): boolean {
  const hasToken = !!(process.env.NGROK_AUTHTOKEN && process.env.NGROK_AUTHTOKEN.trim() !== "");
  return hasToken && isTruthy(process.env.OMNIROUTE_NGROK_AUTOSTART);
}

export type NgrokAutoStartResult = {
  /** `true` only when the tunnel actually reached `phase: "running"`. */
  started: boolean;
  /** Tunnel status when a start was attempted, `null` when the gate was closed. */
  status: NgrokTunnelStatus | null;
};

/**
 * Start the ngrok tunnel at boot when the double opt-in gate is open.
 * No-op (and no import of `@ngrok/ngrok`) when the gate is closed.
 */
export async function initNgrokAutoStart(): Promise<NgrokAutoStartResult> {
  if (!isNgrokAutoStartEnabled()) return { started: false, status: null };

  const status = await startNgrokTunnel();
  return { started: status.phase === "running", status };
}

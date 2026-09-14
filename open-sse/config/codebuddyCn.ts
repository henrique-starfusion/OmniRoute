// CodeBuddy CN (Tencent — copilot.tencent.com) client fingerprint.
//
// Single source of truth for the CLI/CodeBuddy version string. It MUST stay identical
// across OAuth (src/lib/oauth/constants/oauth.ts), chat completions
// (open-sse/config/providers/registry/codebuddy-cn/index.ts) and usage/quota
// (open-sse/services/usage/codebuddy-cn.ts) — a mismatched version string across a
// single account's auth vs. chat calls is exactly the kind of internally-inconsistent
// client fingerprint Tencent's WAF flags as anomalous (#12702).
//
// Pure module on purpose: the provider registry reaches client bundles (via
// src/shared/constants/cliTools.ts), so it must not import oauth.ts, which pulls
// node:fs through cursorAgentCliVersion.ts and breaks the Next build.
export const CODEBUDDY_CN_USER_AGENT = "CLI/2.108.1 CodeBuddy/2.108.1";

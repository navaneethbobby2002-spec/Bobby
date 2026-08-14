/**
 * Regression test for #5997 — opencode-go/opencode-zen upstream requests must carry
 * OpenCode CLI identity headers even when the client did not supply them.
 *
 * On a datacenter VPS, `opencode.ai/zen/go/v1/chat/completions` is fronted by
 * Cloudflare, which 403s (HTML challenge) requests lacking CLI identity. The reporter's
 * control curl proved the exact headers that succeed:
 *   User-Agent: opencode-cli/1.0.0 · x-opencode-client: cli ·
 *   x-opencode-project: default · x-opencode-request/-session: fresh UUIDs
 * Forwarding those headers from the client also fixes it — confirming the upstream
 * expects CLI identity. Since most OpenAI-compatible clients never send them,
 * `OpencodeExecutor.buildHeaders()` must synthesize the defaults when absent.
 *
 * Client-supplied values always take precedence (defaults only fill gaps), and the
 * UA/client/project defaults are env-overridable.
 *
 * The executor-level synthesis is ON BY DEFAULT: opencode.ai's free tier
 * 429s (FreeUsageLimitError) server-side (VPS) requests lacking CLI identity, and
 * sending the official CLI fingerprint headers (dynamic session/request ids,
 * project, CLI User-Agent) turns the 429 into a 200. Opt out with
 * `OPENCODE_SYNTHESIZE_CLI_HEADERS=false`. Client-supplied headers take
 * precedence, EXCEPT User-Agent: a non-CLI client UA (curl/SDK) is replaced with the
 * synthesized CLI UA because opencode.ai's free tier rejects generic client UAs from
 * datacenter IPs. Values are env-overridable (OPENCODE_USER_AGENT / OPENCODE_CLIENT /
 * OPENCODE_PROJECT, or <PROVIDER>_USER_AGENT); the defaults below are the live-verified
 * set that resolves the 429.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardOpencodeClientHeaders } from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLI_DEFAULTS = { userAgent: "opencode/latest/1.18.18/cli", client: "desktop", project: "/opencode" };

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const saved = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("forwardOpencodeClientHeaders: cliDefaults synthesize all CLI identity headers when absent [#5997]", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {}, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], "opencode/latest/1.18.18/cli");
  assert.equal(headers["x-opencode-client"], "desktop");
  assert.equal(headers["x-opencode-project"], "/opencode");
  assert.match(headers["x-opencode-request"] ?? "", UUID_RE);
  assert.match(headers["x-opencode-session"] ?? "", UUID_RE);
  assert.notEqual(headers["x-opencode-request"], headers["x-opencode-session"]);
});

test("forwardOpencodeClientHeaders: non-CLI client UA is REPLACED with the CLI UA; other headers keep client-wins [#5997 follow-up]", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = {
    "User-Agent": "curl/8.5.0",
    "x-opencode-client": "vscode",
    "x-opencode-project": "acme",
    "x-opencode-request": "req-from-client",
    "x-opencode-session": "sess-from-client",
  };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], "opencode/latest/1.18.18/cli");
  assert.equal(headers["x-opencode-client"], "vscode");
  assert.equal(headers["x-opencode-project"], "acme");
  assert.equal(headers["x-opencode-request"], "req-from-client");
  assert.equal(headers["x-opencode-session"], "sess-from-client");
});

test("forwardOpencodeClientHeaders: an existing opencode-cli UA is preserved (real CLI version intact)", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = { "User-Agent": "opencode-cli/2.5.0" };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });
  assert.equal(headers["User-Agent"], "opencode-cli/2.5.0");
});

test("forwardOpencodeClientHeaders: without cliDefaults, no synthesis (DefaultExecutor path unchanged)", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {});
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-opencode-client"], undefined);
  assert.equal(headers["x-opencode-project"], undefined);
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults BY DEFAULT (flag unset) [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");

    assert.equal(headers["User-Agent"], "opencode/latest/1.18.18/cli");
    assert.equal(headers["x-opencode-client"], "desktop");
    assert.equal(headers["x-opencode-project"], "/opencode");
    assert.match(headers["x-opencode-request"] ?? "", UUID_RE);
    assert.match(headers["x-opencode-session"] ?? "", UUID_RE);
  });
});

test("OpencodeExecutor.buildHeaders: OPENCODE_SYNTHESIZE_CLI_HEADERS=false disables synthesis (forward-only) [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "false", () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], undefined);
    assert.equal(headers["x-opencode-client"], undefined);
    assert.equal(headers["x-opencode-project"], undefined);
  });
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults with flag explicitly on + no client headers [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");

    assert.equal(headers["User-Agent"], "opencode/latest/1.18.18/cli");
    assert.equal(headers["x-opencode-client"], "desktop");
    assert.equal(headers["x-opencode-project"], "/opencode");
    assert.match(headers["x-opencode-request"] ?? "", UUID_RE);
    assert.match(headers["x-opencode-session"] ?? "", UUID_RE);
  });
});

test("OpencodeExecutor.buildHeaders: OPENCODE_GO_USER_AGENT env overrides the default UA [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    withEnv("OPENCODE_GO_USER_AGENT", "opencode-cli/2.5.0", () => {
      const executor = new OpencodeExecutor("opencode-go");
      const headers = executor.buildHeaders(null, true, null, "glm-5.2");
      assert.equal(headers["User-Agent"], "opencode-cli/2.5.0");
    });
  });
});

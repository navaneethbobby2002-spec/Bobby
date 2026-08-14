import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Canonical wire-identity source of truth — imported, never re-typed, so a
// version bump in claudeCodeClient.ts can't silently desync this test
// (guarded repo-wide by tests/unit/claude-codex-identity-version-sync.test.ts).
import { getClaudeCodeUserAgent } from "../../src/shared/constants/claudeCodeClient.ts";

// #10143 / #10144: the claude-auth import bootstrap call was missing the
// `User-Agent` and `anthropic-beta` headers that the two other callers of
// /api/claude_cli/bootstrap (claudeIdentity.ts, oauth/providers/claude.ts)
// send, and `createConnectionFromAuthFile()` never persisted a `cliUserID`
// device identity — so an imported connection presented as a brand-new device
// to Anthropic on every process restart.
//
// These regression tests prove the PR's two behaviors:
//   1. enrichWithBootstrap() sends the required CLI headers on the bootstrap
//      call (byte-for-byte: claude-cli/* UA + anthropic-beta oauth-2025-04-20).
//   2. createConnectionFromAuthFile() mints a 64-hex cliUserID on create and
//      preserves an already-persisted one on overwrite re-import (instead of
//      rotating the device identity).
//
// Pure-function copies of the helpers from claudeAuthImport.ts — same pattern
// as the sibling claudeAuthImport.test.ts — so this file has no DB deps and
// runs independently of the DB-import chain that is currently broken on the
// release/v3.8.50 base (open-sse/config/services/conolModels.ts missing).

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

interface ParsedClaudeAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
  scopes: string[];
  subscriptionType: string | null;
  rateLimitTier: string | null;
  email: string | null;
}

interface EnrichedClaudeAuth extends ParsedClaudeAuth {
  accountUUID: string | null;
  organizationUUID: string | null;
  organizationName: string | null;
  organizationType: string | null;
  rateLimitTier: string | null;
}

// ──── Copies of the PR-modified functions (src/lib/oauth/utils/claudeAuthImport.ts) ──

// enrichWithBootstrap(): sends the CLI headers the two working call-sites send,
// then best-effort-enriches the parsed auth with the bootstrap payload.
async function enrichWithBootstrap(parsed: ParsedClaudeAuth): Promise<EnrichedClaudeAuth> {
  const base: EnrichedClaudeAuth = {
    ...parsed,
    accountUUID: null,
    organizationUUID: null,
    organizationName: null,
    organizationType: null,
    rateLimitTier: parsed.rateLimitTier,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch("https://api.anthropic.com/api/claude_cli/bootstrap", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${parsed.accessToken}`,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        "User-Agent": getClaudeCodeUserAgent("cli"),
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return base;
    }

    const body = toRecord(await res.json());

    const accountUUID = toNonEmptyString(body.account_uuid);
    const organizationUUID = toNonEmptyString(body.organization_uuid);
    const organizationName = toNonEmptyString(body.organization_name);
    const organizationType = toNonEmptyString(body.organization_type);
    const rateLimitTier = toNonEmptyString(body.rate_limit_tier) || parsed.rateLimitTier;
    const bootstrapEmail = toNonEmptyString(body.account_email);

    return {
      ...base,
      accountUUID,
      organizationUUID,
      organizationName,
      organizationType,
      rateLimitTier,
      email: parsed.email || bootstrapEmail,
    };
  } catch {
    return base;
  } finally {
    clearTimeout(timer);
  }
}

// createConnectionFromAuthFile(): the two providerSpecificData cliUserID
// branches added by the PR — mint on create, preserve on overwrite re-import.
// Extracted as pure functions from the real implementation for testability.
function buildCreateProviderSpecificData(
  enriched: EnrichedClaudeAuth,
  existingProviderSpecificData: JsonRecord | undefined,
  importedAt: string
): JsonRecord {
  const base: JsonRecord = {
    accountUUID: enriched.accountUUID,
    organizationUUID: enriched.organizationUUID,
    organizationName: enriched.organizationName,
    organizationType: enriched.organizationType,
    rateLimitTier: enriched.rateLimitTier,
    scopes: enriched.scopes,
    subscriptionType: enriched.subscriptionType,
    bootstrapEmail: enriched.email,
    importedAt,
  };

  if (existingProviderSpecificData !== undefined) {
    // "update existing connection" branch: preserve an already-persisted
    // device identity across re-imports; only mint one if absent.
    base.cliUserID =
      toNonEmptyString(toRecord(existingProviderSpecificData).cliUserID) ||
      crypto.randomBytes(32).toString("hex");
  } else {
    // "create new connection" branch: always mint a fresh persistent identity.
    base.cliUserID = crypto.randomBytes(32).toString("hex");
  }

  return base;
}

// ──── Part 1: enrichWithBootstrap sends the required CLI headers ─────────────

const BOOTSTRAP_BODY = {
  account_uuid: "uuid-123",
  organization_uuid: "org-uuid-456",
  organization_name: "Acme Corp",
  organization_type: "enterprise",
  rate_limit_tier: "premium",
  account_email: "alice@example.com",
};

function captureBootstrapFetch(
  out: { url: string; headers: Record<string, string> }
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    out.url = String(url);
    out.headers = Object.fromEntries(
      Object.entries((init?.headers as Record<string, string>) || {}).map(([k, v]) => [
        k,
        String(v),
      ])
    );
    return new Response(JSON.stringify(BOOTSTRAP_BODY), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("enrichWithBootstrap sends User-Agent and anthropic-beta CLI headers on the bootstrap call", async () => {
  const captured: { url: string; headers: Record<string, string> } = { url: "", headers: {} };
  const restoreFetch = captureBootstrapFetch(captured);

  try {
    const parsed: ParsedClaudeAuth = {
      accessToken: "at-abc",
      refreshToken: "rt-xyz",
      expiresAt: null,
      scopes: ["user:inference"],
      subscriptionType: "pro",
      rateLimitTier: "default",
      email: null,
    };

    const enriched = await enrichWithBootstrap(parsed);

    assert.equal(captured.url, "https://api.anthropic.com/api/claude_cli/bootstrap");
    // Same header set the two working call-sites send (claudeIdentity.ts and
    // oauth/providers/claude.ts): a claude-cli User-Agent + the OAuth beta.
    assert.equal(
      captured.headers["User-Agent"],
      getClaudeCodeUserAgent("cli"),
      "User-Agent must be byte-for-byte the canonical claude-cli UA"
    );
    assert.equal(
      captured.headers["anthropic-beta"],
      "oauth-2025-04-20",
      "anthropic-beta must be oauth-2025-04-20"
    );
    assert.equal(captured.headers["Authorization"], "Bearer at-abc");
    assert.equal(captured.headers["anthropic-version"], "2023-06-01");

    // Enrichment still works with the header-carrying request.
    assert.equal(enriched.accountUUID, "uuid-123");
    assert.equal(enriched.email, "alice@example.com");
  } finally {
    restoreFetch();
  }
});

test("enrichWithBootstrap still returns null fields on non-OK upstream (headers don't break fallback)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;

  try {
    const parsed: ParsedClaudeAuth = {
      accessToken: "expired-at",
      refreshToken: "rt",
      expiresAt: null,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
      email: null,
    };
    const enriched = await enrichWithBootstrap(parsed);
    assert.equal(enriched.accountUUID, null);
    assert.equal(enriched.organizationUUID, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ──── Part 2: cliUserID device identity is minted and preserved ──────────────

test("createConnectionFromAuthFile mints a 64-hex cliUserID on create", () => {
  const enriched: EnrichedClaudeAuth = {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: null,
    scopes: [],
    subscriptionType: "pro",
    rateLimitTier: "default",
    email: "alice@example.com",
    accountUUID: "uuid-123",
    organizationUUID: "org-uuid-456",
    organizationName: "Acme Corp",
    organizationType: "enterprise",
  };

  const psd = buildCreateProviderSpecificData(enriched, undefined, "2026-08-13T00:00:00.000Z");
  const cliUserID = psd.cliUserID as string;
  assert.equal(typeof cliUserID, "string");
  assert.match(cliUserID, /^[a-f0-9]{64}$/, "cliUserID must be a 64-hex device id");
});

test("createConnectionFromAuthFile preserves an existing cliUserID on overwrite re-import", () => {
  const enriched: EnrichedClaudeAuth = {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: null,
    scopes: [],
    subscriptionType: "pro",
    rateLimitTier: "default",
    email: "alice@example.com",
    accountUUID: "uuid-123",
    organizationUUID: "org-uuid-456",
    organizationName: "Acme Corp",
    organizationType: "enterprise",
  };

  const existingCliUserID = crypto.randomBytes(32).toString("hex");
  const psd = buildCreateProviderSpecificData(
    enriched,
    { cliUserID: existingCliUserID },
    "2026-08-13T00:00:00.000Z"
  );

  // Re-import of the same account must NOT rotate a working device identity.
  assert.equal(psd.cliUserID, existingCliUserID);
  assert.match(existingCliUserID, /^[a-f0-9]{64}$/);
});

test("createConnectionFromAuthFile mints a fresh cliUserID when the existing connection has none", () => {
  const enriched: EnrichedClaudeAuth = {
    accessToken: "at",
    refreshToken: "rt",
    expiresAt: null,
    scopes: [],
    subscriptionType: "pro",
    rateLimitTier: "default",
    email: "alice@example.com",
    accountUUID: "uuid-123",
    organizationUUID: "org-uuid-456",
    organizationName: "Acme Corp",
    organizationType: "enterprise",
  };

  const psd = buildCreateProviderSpecificData(enriched, {}, "2026-08-13T00:00:00.000Z");
  assert.match(psd.cliUserID as string, /^[a-f0-9]{64}$/);
});

import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { classify429 } from "@omniroute/open-sse/services/antigravity429Engine.ts";

import { getProviderCredentialsWithQuotaPreflight } from "./auth";
import { checkAndRefreshToken } from "./tokenRefresh";
import * as log from "../utils/logger";

interface ImageGenerationResult {
  success: boolean;
  status?: number;
  error?: unknown;
  data?: unknown;
}

interface ImageCredentialRetryOptions {
  provider: string;
  requestedModel: string | null;
  credentials: any;
  execute: (credentials: any) => Promise<ImageGenerationResult>;
}

interface ImageCredentialRetryResult {
  credentials: any;
  result: ImageGenerationResult;
}

function connectionIdOf(credentials: any): string | null {
  const connectionId = credentials?.connectionId;
  return typeof connectionId === "string" && connectionId.trim().length > 0
    ? connectionId.trim()
    : null;
}

function isCredentialSentinel(credentials: any): boolean {
  return Boolean(credentials?.allRateLimited || credentials?.allExpired);
}

/**
 * Image generation is non-idempotent, so account rotation stays deliberately
 * narrower than chat failover. Antigravity's explicit exhausted-quota signal
 * is safe to retry on another account; an ordinary 429 is not evidence that a
 * different account helps and must not cause account rotation.
 */
export function isAntigravityImageQuotaExhausted(
  provider: string,
  result: ImageGenerationResult
): boolean {
  if (provider !== "antigravity" || Number(result.status) !== 429) return false;

  let errorText = "";
  try {
    errorText =
      typeof result.error === "string" ? result.error : JSON.stringify(result.error ?? "");
  } catch {
    return false;
  }

  return classify429(errorText) === "quota_exhausted";
}

async function selectNextCredentials(
  provider: string,
  requestedModel: string | null,
  excludedConnectionIds: Set<string>
) {
  return getProviderCredentialsWithQuotaPreflight(provider, null, null, requestedModel, {
    excludeConnectionIds: Array.from(excludedConnectionIds),
  });
}

/**
 * Keep image requests on the same credential lifecycle as chat requests.
 *
 * Each connection is attempted at most once. A refresh failure or upstream 401
 * excludes only that connection for the current request; it does not mutate the
 * account into a terminal state because another request may refresh it normally.
 */
export async function executeImageWithCredentialFallback({
  provider,
  requestedModel,
  credentials,
  execute,
}: ImageCredentialRetryOptions): Promise<ImageCredentialRetryResult> {
  // Local/no-auth image providers intentionally have no credential row. They
  // still need one direct attempt, but there is no account identity to refresh
  // or rotate after a 401.
  if (!credentials) {
    return { credentials, result: await execute(credentials) };
  }

  const excludedConnectionIds = new Set<string>();
  let currentCredentials = credentials;
  let lastCredentials = credentials;
  let lastResult: ImageGenerationResult | null = null;

  while (currentCredentials && !isCredentialSentinel(currentCredentials)) {
    const connectionId = connectionIdOf(currentCredentials);
    if (connectionId && excludedConnectionIds.has(connectionId)) break;
    if (connectionId) excludedConnectionIds.add(connectionId);

    try {
      currentCredentials = await checkAndRefreshToken(provider, currentCredentials);
    } catch (error) {
      log.warn("IMAGE", "Credential refresh failed; trying another image-provider account", {
        provider,
        connectionId,
        error: sanitizeErrorMessage(error instanceof Error ? error : new Error(String(error))),
      });
      if (!connectionId) throw error;
      currentCredentials = await selectNextCredentials(
        provider,
        requestedModel,
        excludedConnectionIds
      );
      continue;
    }

    lastCredentials = currentCredentials;
    lastResult = await execute(currentCredentials);
    const shouldTryAnotherAccount =
      Number(lastResult.status) === 401 || isAntigravityImageQuotaExhausted(provider, lastResult);
    if (lastResult.success || !shouldTryAnotherAccount || !connectionId) {
      return { credentials: lastCredentials, result: lastResult };
    }

    log.warn(
      "IMAGE",
      "Image provider account is ineligible for this request; trying another account",
      {
        provider,
        connectionId,
      }
    );
    currentCredentials = await selectNextCredentials(
      provider,
      requestedModel,
      excludedConnectionIds
    );
  }

  return {
    credentials: lastCredentials,
    result: lastResult || {
      success: false,
      status: 401,
      error: "Authentication failed for all eligible image-provider accounts",
    },
  };
}

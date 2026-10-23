/**
 * Every OpenAI client the API uses, built in one place.
 *
 * Two clients, each with an explicit baseURL so no environment variable can
 * redirect either one:
 *   - `gateway`: chat, grading and embeddings. The Harvard HUIT gateway when
 *     HARVARD_GATEWAY_URL is set (with the gateway's `api-key` header), else
 *     api.openai.com, both on OPENAI_API_KEY.
 *   - `direct`: api.openai.com always, for what the gateway cannot serve
 *     (TTS, direct billing) and as the realtime key. Its key is OPENAI_TTS_KEY;
 *     with no gateway configured, OPENAI_API_KEY is itself a direct key and
 *     serves. With a gateway and no OPENAI_TTS_KEY there is no direct client,
 *     and direct-only features return a clear error instead of being sent to
 *     a gateway that cannot serve them.
 *
 * The gateway URL lives in HARVARD_GATEWAY_URL, not OPENAI_BASE_URL, because the
 * OpenAI SDK reads OPENAI_BASE_URL (and OPENAI_ORG_ID, OPENAI_PROJECT_ID) from
 * the environment on its own; a name the SDK never reads can only take effect here.
 *
 * The variable names, the default host and the embedding model are the gateway
 * contract (gateway.ts), shared with the Python corpus builders.
 *
 * Every client is bounded (deadline.ts): each attempt times out after
 * OPENAI_TIMEOUT_MS, the SDK retries a failed attempt at most OPENAI_MAX_RETRIES
 * times, and every request goes through deadlineFetch, so the whole call, retries
 * included, stops at the current request's deadline.
 *
 * This is the only file in any package source or in tools that may call `new OpenAI(`;
 * openai-clients.test.ts enforces that.
 */

import { OpenAI } from 'openai';
import { API_KEY_ENV, GATEWAY_URL_ENV, OPENAI_DIRECT_URL } from './gateway.js';
import { deadlineFetch } from './deadline.js';

/**
 * One attempt's limit. Long enough for the slowest call we have seen succeed
 * (text-to-speech, 47 s for 76 characters with gpt-4o-mini-tts), short enough
 * to leave a retry some of the request deadline (REQUEST_DEADLINE_MS, 85 s).
 */
export const OPENAI_TIMEOUT_MS = 60_000;
/** Retries the SDK makes after a failed attempt (connection error, 408, 409, 429, 5xx). The SDK default is 2. */
export const OPENAI_MAX_RETRIES = 1;

type Env = Record<string, string | undefined>;

export interface OpenAIClients {
  /** Chat, grading, embeddings: the gateway if configured, else api.openai.com. */
  gateway: OpenAI;
  /** api.openai.com with a direct key, or null when no direct key exists. */
  direct: OpenAI | null;
  /** Key for minting Realtime client secrets: OPENAI_REALTIME_KEY, else the direct key. */
  realtimeKey: string;
  /** Whether `gateway` points at HARVARD_GATEWAY_URL. */
  usesGateway: boolean;
}

/** Thrown when a feature that must reach api.openai.com has no direct key. */
export class DirectKeyMissingError extends Error {
  constructor(feature: string) {
    super(
      `${feature} needs a direct OpenAI key (OPENAI_TTS_KEY): the Harvard gateway ` +
      `cannot serve it, and none is configured.`,
    );
    this.name = 'DirectKeyMissingError';
  }
}

function makeClient(apiKey: string, baseURL: string, defaultHeaders?: Record<string, string>): OpenAI {
  // organization and project pinned to null for the same reason as baseURL:
  // left undefined, the SDK fills them from OPENAI_ORG_ID / OPENAI_PROJECT_ID.
  return new OpenAI({
    apiKey, baseURL, organization: null, project: null, defaultHeaders,
    timeout: OPENAI_TIMEOUT_MS, maxRetries: OPENAI_MAX_RETRIES, fetch: deadlineFetch,
  });
}

export function buildOpenAIClients(env: Env = process.env): OpenAIClients {
  const apiKey = env[API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set: chat, grading and embeddings cannot run.');
  }
  const gatewayURL = env[GATEWAY_URL_ENV]?.trim() || '';
  const usesGateway = gatewayURL !== '';

  const gateway = usesGateway
    ? makeClient(apiKey, gatewayURL, { 'api-key': apiKey })
    : makeClient(apiKey, OPENAI_DIRECT_URL);

  const directKey = env.OPENAI_TTS_KEY?.trim() || (usesGateway ? '' : apiKey);
  const direct = directKey ? makeClient(directKey, OPENAI_DIRECT_URL) : null;

  const realtimeKey = env.OPENAI_REALTIME_KEY?.trim() || directKey;

  return { gateway, direct, realtimeKey, usesGateway };
}

let cached: OpenAIClients | null = null;

/**
 * The process-wide clients, built on first call from process.env. server.ts
 * calls this once right after loading .env, so a missing key fails at startup.
 */
export function openaiClients(): OpenAIClients {
  if (!cached) cached = buildOpenAIClients();
  return cached;
}

/**
 * The client for a project's `payment_source` setting: 'direct' bills the
 * direct key, anything else the gateway client. Throws DirectKeyMissingError
 * for 'direct' when there is no direct client, rather than billing the gateway.
 */
export function clientForPaymentSource(paymentSource: string | null | undefined, clients: OpenAIClients = openaiClients()): OpenAI {
  if (paymentSource !== 'direct') return clients.gateway;
  if (!clients.direct) throw new DirectKeyMissingError('Direct billing (payment_source "direct")');
  return clients.direct;
}

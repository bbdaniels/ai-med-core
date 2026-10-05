/**
 * fetch, retried while the deployment is restarting.
 *
 * A merge to main makes Railway rebuild and restart the API from the same
 * commit the content push runs on. While the new container takes over, the
 * edge answers 502 (or 503, 504) and open connections are reset. Those are the
 * only failures retried here: the request never reached a healthy server, or
 * may not have. Every other status is the server's own answer and is returned
 * at once, so a 401, a 400 from a guard, or a 500 is never asked twice.
 *
 * A retried request may have been applied the first time, so the caller must
 * only pass requests that are safe to repeat (see AdminApiClient, which says
 * which of its calls are).
 */

/** Waits between attempts: six attempts over 110 seconds. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 45_000];

export interface RetryOptions {
  /** The wait before each retry; its length is the number of retries. */
  delaysMs?: number[];
  /** Told about each retry. Default: console.log. */
  log?: (message: string) => void;
}

const TRANSIENT_STATUS = new Set([502, 503, 504]);
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

export function isTransientStatus(status: number): boolean {
  return TRANSIENT_STATUS.has(status);
}

/** A connection that was refused, reset or timed out; undici reports it as `fetch failed` with a cause. */
export function isTransientNetworkError(error: unknown): boolean {
  for (let e: any = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (typeof e.code === 'string' && TRANSIENT_CODES.has(e.code)) return true;
    for (const inner of Array.isArray(e.errors) ? e.errors : []) {
      if (typeof inner?.code === 'string' && TRANSIENT_CODES.has(inner.code)) return true;
    }
  }
  return false;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * One request, repeated on 502, 503, 504 and connection failures. Returns the
 * first response that is not one of those; when every attempt fails the same
 * way, returns the last response (or throws the last connection error), so the
 * caller reports it as it would have without a retry.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const log = options.log ?? (m => console.log(m));
  const what = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    let failure: unknown = null;
    try {
      res = await fetch(url, init);
      if (!isTransientStatus(res.status)) return res;
    } catch (e) {
      if (!isTransientNetworkError(e)) throw e;
      failure = e;
    }
    if (attempt >= delays.length) {
      if (res) return res;
      throw failure;
    }
    const why = res ? `answered ${res.status}` : `failed (${(failure as any)?.cause?.code ?? (failure as Error).message})`;
    // The body of a discarded response is released, or its socket stays open.
    await res?.body?.cancel().catch(() => {});
    log(`  ${what} ${why}; the service may be restarting. Retry ${attempt + 1} of ${delays.length} in ${Math.round(delays[attempt] / 1000)}s...`);
    await sleep(delays[attempt]);
  }
}

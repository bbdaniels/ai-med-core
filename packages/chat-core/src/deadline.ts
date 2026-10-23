/**
 * One deadline per request, shared by everything the request waits on.
 *
 * Cloudflare, which fronts the API, answers 524 when the origin sends no byte
 * for 100 seconds. Nothing here streams, so a request must be answered whole
 * before then. The cause of a long request is always outbound work: an OpenAI
 * call (retried by the SDK, inside a fallback ladder or a retry loop of ours) or
 * a Kobo fetch. So the bound is set once, here, and every outbound call draws
 * from it:
 *
 * - The API's middleware runs each request inside `withRequestDeadline`, which
 *   puts an AbortSignal that fires at the deadline in an AsyncLocalStorage
 *   context. Everything the request awaits inherits it.
 * - `deadlineFetch` is the one fetch for outbound calls: the OpenAI clients are
 *   built on it (openai-clients.ts) and every other outbound fetch calls it. It
 *   aborts with the request's signal, so a call in flight at the deadline stops
 *   then, and a call begun after it fails at once.
 * - `untilDeadline(work)` settles at the deadline even when the work does not:
 *   the OpenAI SDK sleeps between its retries (up to a minute when the server
 *   sends Retry-After) and that sleep cannot be aborted. A route awaits its work
 *   through it and answers 504 when it rejects with DeadlineExceededError.
 * - A fallback ladder or retry loop that catches errors calls
 *   `throwIfDeadlineExceeded()` first, so it stops instead of degrading into a
 *   weaker answer after the route has already given up.
 *
 * The deadline is REQUEST_DEADLINE_MS. A deployment may set a shorter one with
 * the REQUEST_DEADLINE_MS environment variable (the server harness does, so a
 * test of the cutoff runs in seconds); a value at or past Cloudflare's cutoff is
 * refused.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Cloudflare's proxy answers 524 after this long without a byte from the origin. */
export const CLOUDFLARE_ORIGIN_TIMEOUT_MS = 100_000;

/** Every request is answered within this, retries and fallbacks included. */
export const REQUEST_DEADLINE_MS = 85_000;

type Env = Record<string, string | undefined>;

/**
 * The deadline in force: REQUEST_DEADLINE_MS, or the environment's shorter or
 * equal value. A value that is not a positive whole number of milliseconds
 * below Cloudflare's cutoff is ignored with a warning.
 */
export function requestDeadlineMs(env: Env = process.env, warn: (m: string) => void = console.warn): number {
  const raw = (env.REQUEST_DEADLINE_MS ?? '').trim();
  if (raw === '') return REQUEST_DEADLINE_MS;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n < CLOUDFLARE_ORIGIN_TIMEOUT_MS) return n;
  warn(`REQUEST_DEADLINE_MS=${raw} is not a whole number of milliseconds between 1 and ` +
       `${CLOUDFLARE_ORIGIN_TIMEOUT_MS - 1}; using ${REQUEST_DEADLINE_MS}.`);
  return REQUEST_DEADLINE_MS;
}

/** The request ran out of time. Routes answer it with 504. */
export class DeadlineExceededError extends Error {
  constructor() {
    super('The request took too long and was stopped. Please try again.');
    this.name = 'DeadlineExceededError';
  }
}

const deadlineStore = new AsyncLocalStorage<AbortSignal>();

/** Run `fn`, and everything it awaits, under a deadline `ms` from now. */
export function withRequestDeadline<T>(ms: number, fn: () => T): T {
  return deadlineStore.run(AbortSignal.timeout(ms), fn);
}

/** The current request's deadline signal, or undefined outside a request. */
export function requestSignal(): AbortSignal | undefined {
  return deadlineStore.getStore();
}

/** True once the current request's deadline has passed. */
export function deadlineExceeded(): boolean {
  return requestSignal()?.aborted === true;
}

/** Throw DeadlineExceededError if the current request's deadline has passed. */
export function throwIfDeadlineExceeded(): void {
  if (deadlineExceeded()) throw new DeadlineExceededError();
}

/**
 * fetch, bounded by the current request's deadline. Outside a request (no
 * deadline in context) the call is bounded by REQUEST_DEADLINE_MS from its own
 * start, so no outbound call is ever unbounded. A signal the caller passes
 * (the OpenAI SDK passes its per-attempt timeout) still applies; whichever
 * fires first stops the call. A call stopped by the deadline rejects with
 * DeadlineExceededError.
 */
export const deadlineFetch: typeof fetch = async (input, init) => {
  const deadline = requestSignal() ?? AbortSignal.timeout(REQUEST_DEADLINE_MS);
  if (deadline.aborted) throw new DeadlineExceededError();
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  try {
    return await fetch(input, { ...init, signal });
  } catch (e) {
    if (deadline.aborted) throw new DeadlineExceededError();
    throw e;
  }
};

/**
 * `work`, or DeadlineExceededError at the current request's deadline, whichever
 * comes first. Work still running at the deadline is left to finish on its own;
 * its outbound calls fail at once, since the signal they carry has fired, and
 * its eventual rejection is handled here, never left unhandled.
 */
export function untilDeadline<T>(work: Promise<T>): Promise<T> {
  const signal = requestSignal();
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new DeadlineExceededError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeadlineExceededError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      v => { signal.removeEventListener('abort', onAbort); resolve(v); },
      e => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

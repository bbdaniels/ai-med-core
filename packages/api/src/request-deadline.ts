/**
 * The request deadline, on the HTTP side (the deadline itself and the fetch
 * that honors it are chat-core's deadline.ts).
 *
 * `requestDeadline(ms)` runs every request inside chat-core's
 * withRequestDeadline, so each outbound call the request makes, an OpenAI call
 * or a Kobo fetch, stops at the deadline. It is mounted once, after the body
 * parsers: the clock starts when the request's body has been read.
 *
 * A route whose work includes an OpenAI SDK call awaits that work through
 * untilDeadline, because the SDK's sleep between retries cannot be aborted; a
 * fetch alone stops at the deadline by itself. Every route that calls out
 * calls `answeredDeadline(res, error)` first in its catch: past the deadline it
 * answers 504 with a JSON message, well before Cloudflare's 524 at 100 s.
 */
import type { RequestHandler, Response } from 'express';
import { DeadlineExceededError, deadlineExceeded, withRequestDeadline } from '@ai-med/chat-core';

export function requestDeadline(ms: number): RequestHandler {
  return (_req, _res, next) => withRequestDeadline(ms, () => next());
}

/**
 * If `error` is the deadline, or came after it (a body read the deadline
 * aborted), answer 504 and return true; otherwise return false and leave the
 * answer to the route.
 */
export function answeredDeadline(res: Response, error: unknown): boolean {
  if (!(error instanceof DeadlineExceededError) && !deadlineExceeded()) return false;
  console.warn(`Deadline: ${res.req.method} ${res.req.originalUrl} ran out of time; answering 504`);
  if (!res.headersSent) res.status(504).json({ error: new DeadlineExceededError().message });
  return true;
}

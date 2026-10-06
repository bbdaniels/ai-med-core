/**
 * Graceful stop, in one place.
 *
 * Railway replaces a deployment by sending the old container SIGTERM and,
 * after the service's draining time, SIGKILL. A process that dies of the
 * signal exits non-zero, which Railway reports as a crash; requests in flight
 * are reset. So on SIGTERM or SIGINT the server:
 *
 * 1. stops accepting connections and closes the idle keep-alive ones;
 * 2. lets requests in flight finish, each answered with `Connection: close`
 *    (a chat turn waiting on the model gets its answer);
 * 3. closes what holds the event loop (the database, passed in as `close`);
 * 4. exits 0.
 *
 * Two forced paths, each with its own log line. When the grace period runs
 * out, the connections still open are destroyed and the process exits 0: the
 * stop was asked for and is done, and the line says how many
 * requests were cut. A second signal exits 1 at once.
 *
 * The grace period must be shorter than the platform's draining time, or the
 * SIGKILL arrives first. It is SHUTDOWN_GRACE_SECONDS when set; otherwise five
 * seconds less than RAILWAY_DEPLOYMENT_DRAINING_SECONDS (the service variable
 * that sets Railway's draining time) when that is set; otherwise 10 seconds.
 */
import type { Server } from 'node:http';
import type { RequestHandler } from 'express';

export const DEFAULT_GRACE_SECONDS = 10;
/** Kept between the grace period and the platform's SIGKILL. */
export const DRAINING_MARGIN_SECONDS = 5;

const positive = (raw: string | undefined): number | null => {
  const n = Number((raw ?? '').trim());
  return (raw ?? '').trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

export function shutdownGraceSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const own = positive(env.SHUTDOWN_GRACE_SECONDS);
  if (own !== null) return own;
  const draining = positive(env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS);
  if (draining !== null) return Math.max(1, draining - DRAINING_MARGIN_SECONDS);
  return DEFAULT_GRACE_SECONDS;
}

let stopping = false;

/**
 * While the server is stopping, tell each client to drop its connection after
 * this response, so a keep-alive connection does not outlive the request on it.
 */
export const closeConnectionWhileStopping: RequestHandler = (_req, res, next) => {
  if (stopping) res.setHeader('Connection', 'close');
  next();
};

export interface GracefulShutdownOptions {
  server: Server;
  /** Closes everything else that holds the event loop. Runs once the requests are done. */
  close: () => Promise<void>;
  graceSeconds?: number;
}

export function installGracefulShutdown({ server, close, graceSeconds = shutdownGraceSeconds() }: GracefulShutdownOptions): void {
  const openRequests = () => new Promise<number>(resolve => server.getConnections((_e, n) => resolve(n ?? 0)));

  // process.exit() does not wait for a piped stdout or stderr on every
  // platform, and the last lines are the ones that say how the stop went.
  const exit = (code: number) => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  };

  const finish = async (code: number) => {
    try {
      await close();
    } catch (error) {
      console.error('Shutdown: closing the database failed:', error);
      code = 1;
    }
    exit(code);
  };

  let cut = false;

  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      console.error(`Shutdown: second signal (${signal}), exiting now without waiting for requests in flight`);
      exit(1);
      return;
    }
    stopping = true;
    console.log(`Shutdown: ${signal} received; no new connections, up to ${graceSeconds}s for requests in flight`);

    const timer = setTimeout(async () => {
      cut = true;
      const open = await openRequests();
      console.warn(`Shutdown: grace period of ${graceSeconds}s ended with ${open} connection(s) still open; closing them and exiting`);
      server.closeAllConnections();
      await finish(0);
    }, graceSeconds * 1000);

    server.close(async () => {
      if (cut) return;
      clearTimeout(timer);
      console.log('Shutdown: requests finished, closing the database');
      await finish(0);
    });
    // server.close() leaves idle keep-alive connections to time out on their
    // own, and a request that was already in flight was not told to close its
    // connection, so it goes idle when answered: sweep until none is left.
    server.closeIdleConnections();
    setInterval(() => server.closeIdleConnections(), 100).unref();
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}

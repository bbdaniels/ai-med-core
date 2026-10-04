/**
 * An access code handed to the app in the URL fragment:
 *
 *     https://.../<project>/?vignette=<key>#code=<access code>
 *
 * Pure string functions, so they can be checked without a browser
 * (access-code.check.ts). api-base.ts applies them to window.location.
 *
 * The fragment, not the query string, deliberately: a fragment is never sent to
 * the server, so the code stays out of access logs, proxy logs, and Referer
 * headers. It is also what makes a third-party iframe work in Safari, where
 * storage may be blocked and a token saved on one visit is gone on the next:
 * when the code arrives with every load, that stops mattering. A host page that
 * has its own gate can append the fragment to the iframe URL after its reader
 * passes that gate.
 */

/** The code in a location.hash (with or without the leading #), or null. */
export function accessCodeFromHash(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const value = new URLSearchParams(raw).get('code');
  return value && value.trim() ? value.trim() : null;
}

/**
 * The hash with the code removed and everything else kept, as it should appear
 * in the address bar ("" or "#rest"). Null when the hash holds no code, so the
 * caller leaves the URL alone.
 */
export function hashWithoutAccessCode(hash: string): string | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  if (!params.has('code')) return null;
  params.delete('code');
  const rest = params.toString();
  return rest ? `#${rest}` : '';
}

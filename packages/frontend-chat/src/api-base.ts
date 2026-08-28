/**
 * API base URL for when the frontend is deployed separately from the backend.
 *
 * Set VITE_API_BASE_URL at build time (e.g. "https://api.example.com").
 * Defaults to empty string → same-origin requests (backend serves the frontend).
 */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') || '';

/**
 * Project slug for multi-tenant routing.
 *
 * Set VITE_PROJECT at build time (e.g. "demo", "kidney").
 * When set, every API request includes an X-Project header so the backend
 * routes to the correct database tables for this project.
 */
export const PROJECT: string =
  (import.meta.env.VITE_PROJECT as string | undefined)?.trim() || '';

/**
 * Resolve an API path against the base URL.
 * Usage:  fetch(api('/api/chat'), { ... })
 */
export function api(path: string): string {
  return `${API_BASE}${path}`;
}

/**
 * Course access token for projects that set `requireAccessCode` in project.json.
 *
 * Held in localStorage so a student enters the shared code once, with an
 * in-memory copy behind it. The in-memory copy is not a nicety: this app is
 * embedded in an iframe on Canvas, and Safari's tracking prevention can make
 * localStorage throw or read back empty for a third-party frame. When that
 * happens the token still works for the current page, and the student is asked
 * for the code again next visit rather than being locked out.
 */
const ACCESS_TOKEN_KEY = `access_token_${PROJECT || 'default'}`;
let accessTokenMemory: string | null = null;

export function getAccessToken(): string | null {
  if (accessTokenMemory) return accessTokenMemory;
  try {
    accessTokenMemory = localStorage.getItem(ACCESS_TOKEN_KEY);
  } catch {
    accessTokenMemory = null;
  }
  return accessTokenMemory;
}

/**
 * A course access code handed to the app in the URL fragment:
 *
 *     https://.../ppol5013/#code=smallwins
 *
 * This is how every Canvas surface passes the gate without a student typing
 * anything: the iframe embed, module links, and any future side-nav redirect all
 * carry the coded URL, and Canvas enrollment is what protects it.
 *
 * The fragment, not the query string, deliberately: a fragment is never sent to
 * the server, so the code stays out of access logs, proxy logs, and Referer
 * headers.
 *
 * It also fixes the Safari ITP problem. In a third-party iframe, storage can be
 * blocked, so a token saved on one visit may be gone on the next; when the code
 * arrives with every load, that stops mattering.
 */
export function readAccessCodeFromUrl(): string | null {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return null;
    const value = new URLSearchParams(hash).get('code');
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Remove the code from the address bar, keeping everything else in the URL.
 * Called whether or not the code worked: a wrong code left on display is just as
 * shoulder-surfable as a right one, and it would be re-submitted on every reload.
 */
export function scrubAccessCodeFromUrl(): void {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (!params.has('code')) return;
    params.delete('code');
    const rest = params.toString();
    const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
    window.history.replaceState(null, '', url);
  } catch {
    /* history blocked (sandboxed frame); the code stays visible but still works */
  }
}

export function setAccessToken(token: string | null): void {
  accessTokenMemory = token;
  try {
    if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
    else localStorage.removeItem(ACCESS_TOKEN_KEY);
  } catch {
    /* storage blocked; the in-memory copy carries this session */
  }
}

/**
 * Headers to include with every API request for project routing and access.
 * Merges with any existing headers the caller provides.
 */
export function projectHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (PROJECT) {
    headers['X-Project'] = PROJECT;
  }
  const token = getAccessToken();
  if (token) {
    headers['X-Access-Token'] = token;
  }
  return headers;
}

/**
 * Fetch wrapper that automatically includes the X-Project header for multi-tenant
 * routing, and the access token when one has been obtained.
 * Drop-in replacement for native fetch() — use for all API calls.
 */
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const token = getAccessToken();
  if (!PROJECT && !token) return fetch(input, init);
  const headers = new Headers(init?.headers);
  if (PROJECT) headers.set('X-Project', PROJECT);
  if (token) headers.set('X-Access-Token', token);
  return fetch(input, { ...init, headers });
}

/**
 * The origin where the API lives — used for building absolute URLs
 * (e.g. transcript links embedded in Kobo form prefills).
 * Falls back to window.location.origin when API_BASE is empty.
 */
export function apiOrigin(): string {
  if (API_BASE) {
    try {
      return new URL(API_BASE).origin;
    } catch {
      return API_BASE;
    }
  }
  return window.location.origin;
}

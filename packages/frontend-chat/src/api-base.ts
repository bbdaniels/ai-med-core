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
 * Headers to include with every API request for project routing.
 * Merges with any existing headers the caller provides.
 */
export function projectHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (PROJECT) {
    headers['X-Project'] = PROJECT;
  }
  return headers;
}

/**
 * Fetch wrapper that automatically includes the X-Project header for multi-tenant routing.
 * Drop-in replacement for native fetch() — use for all API calls.
 */
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (PROJECT) {
    const headers = new Headers(init?.headers);
    headers.set('X-Project', PROJECT);
    return fetch(input, { ...init, headers });
  }
  return fetch(input, init);
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

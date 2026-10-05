// Reading GET /api/languages into one of three states, without React, so the
// rules are checked on their own (languages-load.check.ts).
//
// - 200 with a languages object: the project's file.
// - 404: the project has no languages file. That is a project state, not a
//   failure, and the page says so explicitly: it runs on FALLBACK_LANGUAGES,
//   English with a fixed opening message, so the first turn is that message
//   and no model call is made to invent a greeting.
// - anything else (another status, a body that is not a languages object, a
//   network failure): an error. The page shows it rather than treating an
//   error body as a languages file or spinning on "Loading..." for good.
//   (Before this, any response body was taken as the file, so a 404 or 500
//   produced a page with no strings and a model-written opening; the first-use
//   seed race, which answered 404 for a project that had a file, hid it.)

import type { LanguagesJson } from './types';

export type LanguagesLoad =
  | { status: 'loading' }
  | { status: 'ready'; langs: LanguagesJson; source: 'file' | 'fallback' }
  | { status: 'error'; message: string };

/** What a project with no languages file runs on: English, every other string from the pages' own defaults. */
export const FALLBACK_LANGUAGES: LanguagesJson = {
  languages: [{ code: 'en', name: 'English' }],
  ui: {
    en: {
      chat: {
        openingMessage: 'Hello. Ask a question to begin.',
      },
    } as unknown as LanguagesJson['ui'][string],
  },
};

function isLanguagesJson(body: unknown): body is LanguagesJson {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return !!b.ui && typeof b.ui === 'object' && !Array.isArray(b.ui)
    && (b.languages === undefined || Array.isArray(b.languages));
}

/** Fetch and classify the project's languages file. Never throws. */
export async function loadLanguages(fetchLanguages: () => Promise<Response>): Promise<LanguagesLoad> {
  let res: Response;
  try {
    res = await fetchLanguages();
  } catch (e) {
    return { status: 'error', message: `The page could not reach the server (${(e as Error)?.message || 'network error'}).` };
  }
  if (res.status === 404) return { status: 'ready', langs: FALLBACK_LANGUAGES, source: 'fallback' };
  if (!res.ok) return { status: 'error', message: `The server could not send this page's settings (HTTP ${res.status}).` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { status: 'error', message: "The server sent this page's settings in a form it cannot read." };
  }
  if (!isLanguagesJson(body)) {
    return { status: 'error', message: "The server sent this page's settings in a form it cannot read." };
  }
  return { status: 'ready', langs: body, source: 'file' };
}

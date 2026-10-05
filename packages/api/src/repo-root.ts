/**
 * The checkout the server reads from: `.env`, `projects/` (configs, prompts,
 * vignettes, rubrics, tab files) and `transcripts/`.
 *
 * It is the repository this package sits in (three levels up from `src/` or
 * `dist/`), unless `AI_MED_REPO_ROOT` names another directory. The test harness
 * sets it to a throwaway view of the tracked files, so a test sees what a clean
 * checkout sees and never the gitignored content of a working copy (see
 * test-support/tracked-view.ts). Nothing in a deployment sets it.
 *
 * This is the one definition; every module that needs the repository root
 * imports it from here. PACKAGE_DEFAULTS_DIR is defined here for the same
 * reason: `here` is `src/` under tsx and `dist/` in the bundle, and both sit
 * next to `defaults/`, so the path holds in either; a module in a deeper
 * directory (db/) could not resolve it from its own location.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = process.env.AI_MED_REPO_ROOT?.trim()
  ? path.resolve(process.env.AI_MED_REPO_ROOT.trim())
  : path.resolve(here, '../../..');

/** packages/api/defaults: the seed content for a fresh deployment. */
export const PACKAGE_DEFAULTS_DIR = path.resolve(here, '../defaults');

/**
 * packages/frontend-chat/dist-talk: the talk page builds the server serves, one
 * `<url-slug>/` each (tools/build-frontends.ts --app talk, run by railway.json).
 * Like PACKAGE_DEFAULTS_DIR it is found from this package, not from REPO_ROOT,
 * so a test's fixture checkout never hides it; TALK_DIST_DIR overrides it.
 */
export const DEFAULT_TALK_DIST_DIR = path.resolve(here, '../../frontend-chat/dist-talk');

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
 * imports it from here.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = process.env.AI_MED_REPO_ROOT?.trim()
  ? path.resolve(process.env.AI_MED_REPO_ROOT.trim())
  : path.resolve(here, '../../..');

/**
 * Sync one research deck's knowledge packs into the `decks` project.
 *
 *   npx tsx tools/sync-deck-packs.ts <packs-dir> --deck <deck-id>            # write
 *   npx tsx tools/sync-deck-packs.ts <packs-dir> --deck <deck-id> --check    # report only
 *
 *   npx tsx tools/sync-deck-packs.ts path/to/deck/packs --deck trial-2026-01
 *
 * Both are arguments: the tool names no deck and no path of its own. A project
 * records the ones it uses in its own (unpublished) README.
 *
 * The deck build writes, in <packs-dir>:
 *   _deck.md         what is true for the whole deck
 *   <slide-id>.md    one file per slide
 *
 * Each slide becomes one vignette, key `<deck>--<slide-id>`, whose content is
 * that slide's pack and nothing else. The deck pack becomes the deck's
 * grounding set: the file grounding/<deck>.md, with the deck listed in
 * project.json `groundingSets`. /api/chat sends it once per turn, before the
 * documents, on a turn whose current slide is of that deck. A turn of a project
 * that follows a host page can send two vignettes (the current slide and the
 * one asked about before it), and a deck pack copied into each vignette would
 * be sent twice. Grounding is chosen by the key's prefix before `--`, so
 * several decks can live in the project and none gets another's notes.
 *
 * What a sync writes, all under projects/decks/:
 *   cases/slide/<key>.md     the vignette files (gitignored: unpublished results)
 *   grounding/<deck>.md      the deck notes (gitignored for the same reason)
 *   project.json             cases.vignettes, this deck's entries replaced; groundingSets
 *   languages.json           vignetteInfo, the slide title the chat header shows
 * Entries and files of OTHER decks are left alone; files of this deck whose
 * slide no longer exists are removed. Nothing here talks to a deployment:
 * tools/push-content.ts uploads the vignettes and the grounding file.
 *
 * The model is gpt-4o-mini, which quotes well and reads table layouts badly, so
 * a pack must state each number in a sentence with its table, row and column.
 * This script refuses a pack that carries a markdown table, and one too long
 * for the budget below. See projects/decks/README.md for the pack contract.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Deck and slide ids: lowercase, digits, single hyphens. `--` is the separator. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The longest key the frontend accepts in ?vignette= (readVignetteParam). */
const MAX_KEY = 100;

/**
 * Size budget for the deck notes plus one slide pack, in characters (a turn
 * sends the notes once and one or two slide packs).
 * gpt-4o-mini has a 128,000-token context and /api/chat caps the answer at
 * 1,000 tokens. At about 4 characters per token the hard cap is about 12,000
 * tokens: with the system prompt and the JSON instruction (about 1,500 tokens)
 * that is roughly a tenth of the context, which leaves a long conversation's
 * history far more room than it will use. The cap is there for accuracy and
 * cost, not for fit: a small model quotes best from a short pack, and every
 * turn re-sends the whole vignette.
 */
export const WARN_CHARS = 24_000;
export const MAX_CHARS = 48_000;

export interface Pack {
  /** Front matter, keys lowercased. */
  meta: Record<string, string>;
  body: string;
}

export interface DeckVignette {
  key: string;
  slideId: string;
  /** What the chat header shows, e.g. "Slide 7: Patna, correct case management". */
  title: string;
  content: string;
}

export interface DeckBuild {
  deck: string;
  deckTitle: string;
  version: string;
  /** `fixture: true` in _deck.md: a test deck, which writeDeck refuses. */
  fixture: boolean;
  /** The deck-wide notes, synced as the project's grounding file. */
  notes: string;
  vignettes: DeckVignette[];
  warnings: string[];
}

/** The deck notes file of a deck, relative to the project folder: its grounding set's file. */
export const deckNotesFile = (deck: string) => `grounding/${deck}.md`;

/** Split `--- key: value ... ---` front matter from the body. */
export function parsePack(raw: string, name: string): Pack {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${name}: no front matter. A pack starts with a --- block that has at least "title:".`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${name}: front matter line is not "key: value": ${line}`);
    meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  const body = m[2].trim();
  if (!meta.title) throw new Error(`${name}: front matter has no "title:".`);
  if (!body) throw new Error(`${name}: the pack has no body.`);
  // A markdown table asks the model to read a layout. Refuse it: the pack must
  // say each number in a sentence with its exhibit and cell.
  const tableLine = body.split('\n').find(l => /^\s*\|.*\|\s*$/.test(l));
  if (tableLine) {
    throw new Error(`${name}: contains a markdown table ("${tableLine.trim().slice(0, 60)}"). ` +
                    'State each number in a sentence with its table, row and column instead.');
  }
  return { meta, body };
}

/** Build every vignette of one deck from its packs folder. Pure: writes nothing. */
export function buildDeckVignettes(packsDir: string, deck: string): DeckBuild {
  if (!ID.test(deck)) throw new Error(`deck id "${deck}" must be lowercase letters, digits and single hyphens`);
  const deckFile = path.join(packsDir, '_deck.md');
  if (!fs.existsSync(deckFile)) throw new Error(`${deckFile} not found: the deck-wide pack is required`);
  const deckPack = parsePack(fs.readFileSync(deckFile, 'utf8'), '_deck.md');
  const version = deckPack.meta.version || '';
  const warnings: string[] = [];
  const notes = [
    'DECK NOTES (true for every slide of this deck)',
    `Deck: ${deckPack.meta.title} (id ${deck})`,
    ...(version ? [`Deck version: ${version}`] : []),
    '',
    deckPack.body,
    '',
  ].join('\n');

  const slideFiles = fs.readdirSync(packsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
    .sort();
  if (slideFiles.length === 0) throw new Error(`${packsDir}: no slide packs (<slide-id>.md) beside _deck.md`);

  const built: Array<DeckVignette & { order: number }> = [];
  for (const file of slideFiles) {
    const slideId = file.slice(0, -3);
    if (!ID.test(slideId)) {
      throw new Error(`${file}: slide id "${slideId}" must be lowercase letters, digits and single hyphens`);
    }
    const key = `${deck}--${slideId}`;
    if (key.length > MAX_KEY) throw new Error(`${file}: key "${key}" is longer than ${MAX_KEY} characters`);
    const pack = parsePack(fs.readFileSync(path.join(packsDir, file), 'utf8'), file);
    const number = pack.meta.slide || '';
    const title = number ? `Slide ${number}: ${pack.meta.title}` : pack.meta.title;
    const content = [
      'SLIDE PACK',
      `Slide id: ${slideId}`,
      ...(number ? [`Slide number: ${number}`] : []),
      `Slide title: ${pack.meta.title}`,
      '',
      pack.body,
      '',
    ].join('\n');
    const size = notes.length + content.length;
    if (size > MAX_CHARS) {
      throw new Error(`${file}: deck notes plus slide pack is ${size} characters, over the ` +
                      `${MAX_CHARS} cap (about ${Math.round(MAX_CHARS / 4)} tokens). Shorten the pack.`);
    }
    if (size > WARN_CHARS) {
      warnings.push(`${file}: ${size} characters with the deck notes (about ${Math.round(size / 4)} tokens); ` +
                    `a small model quotes more reliably under ${WARN_CHARS}.`);
    }
    const order = /^\d+(\.\d+)?$/.test(number) ? Number(number) : Number.MAX_SAFE_INTEGER;
    built.push({ key, slideId, title, content, order });
  }
  built.sort((a, b) => a.order - b.order || a.slideId.localeCompare(b.slideId));
  return {
    deck,
    deckTitle: deckPack.meta.title,
    version,
    fixture: /^(true|yes)$/i.test(deckPack.meta.fixture || ''),
    notes,
    vignettes: built.map(({ order: _order, ...v }) => v),
    warnings,
  };
}

const TEMPLATE = 'slide';

/** Write a deck's vignettes into projects/<project>/ and register them. */
export function writeDeck(build: DeckBuild, project = 'decks', repoRoot = REPO_ROOT): string[] {
  if (build.fixture) {
    throw new Error(`${build.deck}: _deck.md says "fixture: true". A fixture deck is for tests and is never written into a project.`);
  }
  const projectDir = path.join(repoRoot, 'projects', project);
  const casesRel = `projects/${project}/cases/${TEMPLATE}`;
  const casesDir = path.join(repoRoot, casesRel);
  const prefix = `${build.deck}--`;
  const log: string[] = [];
  fs.mkdirSync(casesDir, { recursive: true });

  const projectFile = path.join(projectDir, 'project.json');
  const config = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
  const notesRel = `projects/${project}/${deckNotesFile(build.deck)}`;

  const keep = new Set(build.vignettes.map(v => `${v.key}.md`));
  for (const f of fs.readdirSync(casesDir)) {
    if (f.startsWith(prefix) && f.endsWith('.md') && !keep.has(f)) {
      fs.unlinkSync(path.join(casesDir, f));
      log.push(`removed stale ${casesRel}/${f}`);
    }
  }
  for (const v of build.vignettes) {
    fs.writeFileSync(path.join(casesDir, `${v.key}.md`), v.content);
    log.push(`wrote ${casesRel}/${v.key}.md (${v.content.length} chars)`);
  }
  fs.mkdirSync(path.dirname(path.join(repoRoot, notesRel)), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, notesRel), build.notes);
  log.push(`wrote ${notesRel} (${build.notes.length} chars), the deck's grounding set`);
  config.groundingSets = [...new Set([...(config.groundingSets ?? []), build.deck])].sort();

  const others = (config.cases.vignettes as Array<{ key: string }>).filter(v => !v.key.startsWith(prefix));
  config.cases.vignettes = [
    ...others,
    ...build.vignettes.map(v => ({
      key: v.key, template: TEMPLATE, title: v.title, file: `${casesRel}/${v.key}.md`,
    })),
  ];
  fs.writeFileSync(projectFile, JSON.stringify(config, null, 2) + '\n');
  log.push(`project.json: ${build.vignettes.length} vignette(s) for ${build.deck}, ${others.length} for other decks; groundingSets ${config.groundingSets.join(', ')}`);

  const langFile = path.join(projectDir, 'languages.json');
  const langs = JSON.parse(fs.readFileSync(langFile, 'utf8'));
  const info: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(langs.vignetteInfo ?? {})) if (!k.startsWith(prefix)) info[k] = val;
  for (const v of build.vignettes) {
    info[v.key] = { title: v.title, scenarioDescription: build.deckTitle + (build.version ? `, version ${build.version}` : '') };
  }
  langs.vignetteInfo = info;
  fs.writeFileSync(langFile, JSON.stringify(langs, null, 2) + '\n');
  log.push('languages.json: vignetteInfo updated');
  return log;
}

function main(argv: string[]): number {
  const args = argv.filter(a => !a.startsWith('--'));
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const packsArg = args[0];
  const deck = flag('--deck');
  const project = flag('--project') || 'decks';
  if (!packsArg || !deck || packsArg === deck) {
    console.error('usage: npx tsx tools/sync-deck-packs.ts <packs-dir> --deck <deck-id> [--project decks] [--check]');
    return 2;
  }
  const packsDir = path.resolve(packsArg.replace(/^~(?=\/)/, process.env.HOME || '~'));
  try {
    const build = buildDeckVignettes(packsDir, deck);
    for (const w of build.warnings) console.warn(`WARNING ${w}`);
    console.log(`${build.deckTitle}${build.version ? ` (version ${build.version})` : ''}: ${build.vignettes.length} slide(s), ` +
                `deck notes ${build.notes.length} chars (sent once per turn)`);
    for (const v of build.vignettes) console.log(`  ${v.key}  ${v.content.length} chars  ${v.title}`);
    if (argv.includes('--check')) {
      console.log('--check: nothing written');
      return 0;
    }
    for (const line of writeDeck(build, project)) console.log(line);
    console.log(`\nNext: npx tsx tools/validate-projects.ts ${project}, then push (see projects/${project}/README.md).`);
    return 0;
  } catch (e) {
    console.error(`ABORT: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

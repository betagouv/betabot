import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { prepareText } from "./search.js";

const DATA = config.dataDir;

interface MemberIndexEntry {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  competences: string[];
}

interface StartupIndexEntry {
  id: string;
  name: string;
  description: string;
  active_member_count: number;
}

/** A resolved entity with its canonical slug and profile URL. */
export interface DetectedEntity {
  id: string;
  label: string;
  url: string;
}

/** Members and startups explicitly mentioned in a user query. */
export interface DetectedEntities {
  members: DetectedEntity[];
  startups: DetectedEntity[];
}

// Module-level caches — built once on first call, reused across requests.
let memberTokens: Map<string, Set<string>> | null = null;
let memberInverse: Map<string, MemberIndexEntry[]> | null = null;

let startupTokens: Map<string, Set<string>> | null = null;
let startupInverse: Map<string, StartupIndexEntry[]> | null = null;

/**
 * Builds two lookup structures from a list of entries:
 * - `tokenMap`: id → set of normalized tokens for that entry
 * - `inverse`: token → entries that contain it (for O(1) candidate lookup)
 */
function buildTokenIndex<T extends { id: string }>(
  entries: T[],
  getTokens: (e: T) => string[],
): { tokenMap: Map<string, Set<string>>; inverse: Map<string, T[]> } {
  const tokenMap = new Map<string, Set<string>>();
  const inverse = new Map<string, T[]>();

  for (const entry of entries) {
    const tokens = new Set(getTokens(entry));
    tokenMap.set(entry.id, tokens);
    for (const t of tokens) {
      const list = inverse.get(t) ?? [];
      list.push(entry);
      inverse.set(t, list);
    }
  }
  return { tokenMap, inverse };
}

/** Lazy-loads the member token index from data/index/members.json. */
function ensureMembersLoaded() {
  if (memberTokens) return;
  const entries = JSON.parse(
    fs.readFileSync(path.join(DATA, "index/members.json"), "utf-8"),
  ) as MemberIndexEntry[];

  const { tokenMap, inverse } = buildTokenIndex(entries, (e) => [
    ...prepareText(e.fullname),
    ...prepareText(e.id), // dot in "julien.bouquillon" is a non-alphanum separator
  ]);
  memberTokens = tokenMap;
  memberInverse = inverse;
}

/** Lazy-loads the startup token index from data/index/startups.json. */
function ensureStartupsLoaded() {
  if (startupTokens) return;
  const entries = JSON.parse(
    fs.readFileSync(path.join(DATA, "index/startups.json"), "utf-8"),
  ) as StartupIndexEntry[];

  const { tokenMap, inverse } = buildTokenIndex(entries, (e) => [
    ...prepareText(e.name),
    ...prepareText(e.id.replace(/-/g, " ")), // "aidants-connect" → ["aidants","connect"]
    e.id.replace(/-/g, ""), // also index as single token so "lasuite" matches directly
  ]);
  startupTokens = tokenMap;
  startupInverse = inverse;
}

/**
 * Scores each entity by how many of its name tokens appear in the query,
 * ranks by coverage ratio (matched / total entity tokens), returns top K.
 * Score ≥ 1 required — prevents injecting entities from purely topical queries.
 */
function matchByTokens<T extends { id: string }>(
  queryText: string,
  tokenMap: Map<string, Set<string>>,
  inverse: Map<string, T[]>,
  getLabel: (e: T) => string,
  getUrl: (e: T) => string,
  topK = 3,
): DetectedEntity[] {
  const queryTokens = new Set(prepareText(queryText));
  const scores = new Map<string, number>();
  const entryById = new Map<string, T>();

  for (const qt of queryTokens) {
    for (const entry of inverse.get(qt) ?? []) {
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1);
      entryById.set(entry.id, entry);
    }
  }

  return Array.from(scores.entries())
    .filter(([, score]) => score >= 1)
    .sort((a, b) => {
      const sizeA = tokenMap.get(a[0])?.size ?? 1;
      const sizeB = tokenMap.get(b[0])?.size ?? 1;
      return b[1] / sizeB - a[1] / sizeA;
    })
    .slice(0, topK)
    .map(([id]) => {
      const entry = entryById.get(id)!;
      return { id, label: getLabel(entry), url: getUrl(entry) };
    });
}

const debug = (...args: unknown[]) =>
  process.stderr.write(`[entity-detector] ${args.join(" ")}\n`);

/**
 * Detects members and startups explicitly mentioned in `text` using token
 * overlap against in-memory name indexes. Synchronous, no LLM or embedding
 * call. Returns empty arrays on any error so the orchestrator is never blocked.
 */
export function detectEntities(text: string): DetectedEntities {
  try {
    ensureMembersLoaded();
    ensureStartupsLoaded();

    const members = matchByTokens(
      text,
      memberTokens!,
      memberInverse!,
      (e) => e.fullname,
      (e) => `https://espace-membre.beta.gouv.fr/community/${e.id}`,
    );

    const startups = matchByTokens(
      text,
      startupTokens!,
      startupInverse!,
      (e) => e.name,
      (e) => `https://beta.gouv.fr/startups/${e.id}`,
    );

    debug(
      `query=${JSON.stringify(text.slice(0, 80))}`,
      `members=[${members.map((e) => `${e.id}(${e.label})`).join(", ") || "none"}]`,
      `startups=[${startups.map((e) => `${e.id}(${e.label})`).join(", ") || "none"}]`,
    );

    return { members, startups };
  } catch (err) {
    debug(`error: ${err}`);
    return { members: [], startups: [] };
  }
}

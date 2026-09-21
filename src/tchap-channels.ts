import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { embedText, loadBin } from "./embed.js";
import { loadBM25Index, hybridSearch } from "./search.js";

export interface TchapChannel {
  url: string;
  name: string;
  description: string;
}

export interface FindChannelsOpts {
  /** Maximum number of distinct channels to return. Default 5. */
  topK?: number;
  /**
   * Minimum relevance ratio: a channel is kept only if its fused score is at
   * least `minRatio` × the best score of the query (robust to corpus size).
   * Default 0.5.
   */
  minRatio?: number;
}

/**
 * Pure selection step: given hybrid-search results ranked by descending fused
 * score, dedupes by `url` (keeping the highest-scoring occurrence, since the
 * corpus can contain repeated rows) and keeps at most `topK` distinct channels
 * whose score is at least `minRatio` × the best score. Extracted for
 * unit-testing — `findChannels` applies it to the live hybrid results.
 */
export function selectChannels(
  results: Array<TchapChannel & { score: number }>,
  opts: FindChannelsOpts = {},
): TchapChannel[] {
  const topK = opts.topK ?? 5;
  const minRatio = opts.minRatio ?? 0.5;
  if (results.length === 0) return [];
  const best = results[0].score;
  const seen = new Set<string>();
  const selected: TchapChannel[] = [];
  for (const r of results) {
    if (r.score < best * minRatio) continue;
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    selected.push({ url: r.url, name: r.name, description: r.description });
    if (selected.length >= topK) break;
  }
  return selected;
}

let DATA = config.dataDir;

let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: TchapChannel[] | null = null;
let channelsConfigured = false;

async function ensureConfigured(): Promise<void> {
  if (channelsConfigured) return;
  channelsConfigured = true;
  const channelsPath = process.env["TCHAP_CHANNELS"] ?? config.tchapChannels;
  if (!channelsPath || !fs.existsSync(channelsPath)) return;

  const binPath = path.join(DATA, "channels.embeddings.bin");
  const bm25Path = path.join(DATA, "channels.bm25.json");
  const indexPath = path.join(DATA, "channels.index.json");
  if (
    !fs.existsSync(binPath) ||
    !fs.existsSync(bm25Path) ||
    !fs.existsSync(indexPath)
  ) {
    return;
  }

  const dims = config.openai.embedDims;
  matrix = loadBin(binPath, dims);
  bm25 = await loadBM25Index(bm25Path);
  indexEntries = JSON.parse(
    fs.readFileSync(indexPath, "utf-8"),
  ) as TchapChannel[];
}

/**
 * Finds Tchap channels related to `query` using hybrid retrieval over the
 * channels built from tchap-channels.json. Returns at most `topK` distinct
 * (deduped by url) channels whose fused score is at least `minRatio` × the
 * best score. Returns [] when TCHAP_CHANNELS is unset, empty, or the indexes
 * are missing (development) — never throws, so the orchestrator is never
 * blocked.
 */
export async function findChannels(
  query: string,
  opts: FindChannelsOpts = {},
): Promise<TchapChannel[]> {
  const topK = opts.topK ?? 5;
  const minRatio = opts.minRatio ?? 0.5;

  try {
    await ensureConfigured();
    if (!matrix || !indexEntries || !bm25) return [];

    const queryVec = await embedText(query);
    const results = await hybridSearch(
      query,
      queryVec,
      matrix,
      bm25,
      indexEntries,
      config.openai.embedDims,
      Math.max(topK * 3, 30),
    );
    return selectChannels(results, { topK, minRatio });
  } catch {
    return [];
  }
}

/** Clears caches and re-reads config — test use only. */
export function _reset(): void {
  channelsConfigured = false;
  matrix = null;
  bm25 = null;
  indexEntries = null;
}

/** Overrides the data directory and clears caches — test use only. */
export function _setDataDir(dir: string): void {
  DATA = dir;
  _reset();
}

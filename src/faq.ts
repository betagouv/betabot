import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { embedText, loadBin } from "./embed.js";
import { loadBM25Index, hybridSearch } from "./search.js";

export interface FaqAnswer {
  question: string;
  answer: string;
  sources: string[];
  url?: string;
}

export interface FindFaqOpts {
  /** Maximum number of FAQ answers to return. Default 3. */
  topK?: number;
  /**
   * Minimum relevance ratio: an answer is kept only if its fused score is at
   * least `minRatio` × the best score of the query (robust to corpus size).
   * Default 0.5.
   */
  minRatio?: number;
}

/**
 * Pure selection step: given hybrid-search results ranked by descending fused
 * score, keeps at most `topK` answers whose score is at least `minRatio` × the
 * best score. Extracted for unit-testing — `findFaqAnswers` applies it to the
 * live hybrid results.
 */
export function selectFaqAnswers(
  results: Array<FaqAnswer & { score: number }>,
  opts: FindFaqOpts = {},
): FaqAnswer[] {
  const topK = opts.topK ?? 3;
  const minRatio = opts.minRatio ?? 0.5;
  if (results.length === 0) return [];
  const best = results[0].score;
  return results
    .filter((r) => r.score >= best * minRatio)
    .slice(0, topK)
    .map(({ question, answer, sources, url }) => ({
      question,
      answer,
      sources,
      url,
    }));
}

let DATA = config.dataDir;

let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: FaqAnswer[] | null = null;

async function ensureLoaded(): Promise<void> {
  if (matrix) return;
  const binPath = path.join(DATA, "faq/docs.embeddings.bin");
  const bm25Path = path.join(DATA, "faq/docs.bm25.json");
  const indexPath = path.join(DATA, "faq/docs.index.json");
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
  ) as FaqAnswer[];
}

/**
 * Finds FAQ reference answers related to `query` using hybrid retrieval over
 * the faq.md index (built by `buildFaqEmbeddings`). Returns at most `topK`
 * answers whose fused score is at least `minRatio` × the best score. Returns
 * [] when the FAQ index is missing (development) — never throws, so the
 * orchestrator is never blocked.
 */
export async function findFaqAnswers(
  query: string,
  opts: FindFaqOpts = {},
): Promise<FaqAnswer[]> {
  const topK = opts.topK ?? 3;
  const minRatio = opts.minRatio ?? 0.5;

  try {
    await ensureLoaded();
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
    return selectFaqAnswers(results, { topK, minRatio });
  } catch {
    return [];
  }
}

/** Clears caches — test use only. */
export function _reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}

/** Overrides the data directory and clears caches — test use only. */
export function _setDataDir(dir: string): void {
  DATA = dir;
  _reset();
}

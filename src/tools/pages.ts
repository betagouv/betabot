import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const PAGES_DIR = path.join(DATA, "beta.gouv.fr");
const DIMS = config.openai.embedDims;

interface PageChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}

// Lazy-loaded
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: PageChunk[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(PAGES_DIR, "pages.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(PAGES_DIR, "pages.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(PAGES_DIR, "pages.index.json"), "utf-8")
  ) as PageChunk[];
}

async function search_pages(
  query: string,
  top_k = 5
): Promise<Array<PageChunk & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(
    query,
    queryVec,
    matrix!,
    bm25,
    indexEntries!,
    DIMS,
    top_k
  );
}

async function get_page(pagePath: string): Promise<string | null> {
  const fullPath = path.join(PAGES_DIR, "_pages", pagePath);
  if (!fs.existsSync(fullPath)) return null;
  const raw = fs.readFileSync(fullPath, "utf-8");
  // Strip HTML tags keeping text content for a cleaner LLM-readable output
  return raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchPagesTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_pages",
    description:
      "Recherche dans les pages institutionnelles de beta.gouv.fr : approche, manifeste, phases (investigation, construction, accélération, transfert), méthode produit, comment rejoindre, etc.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'c'est quoi l'investigation', 'comment fonctionne le programme'",
        },
        top_k: {
          type: "integer",
          description: "Nombre de résultats (défaut: 5)",
          default: 5,
        },
      },
      required: ["query"],
    },
  },
};

const getPageTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_page",
    description:
      "Récupère le contenu complet d'une page institutionnelle beta.gouv.fr par son chemin relatif.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Chemin relatif de la page, issu de search_pages (ex: manifeste.md, programme/investigation.md)",
        },
      },
      required: ["path"],
    },
  },
};

export const tools = [searchPagesTool, getPageTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_pages: (args) =>
    search_pages(args["query"] as string, (args["top_k"] as number) ?? 5),
  get_page: (args) => get_page(args["path"] as string),
};

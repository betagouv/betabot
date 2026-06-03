import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const DOCS_DIR = path.join(DATA, "docs-dsfr");
const DIMS = config.openai.embedDims;

interface DocChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}

let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: DocChunk[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(DOCS_DIR, "docs.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(DOCS_DIR, "docs.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(DOCS_DIR, "docs.index.json"), "utf-8"),
  ) as DocChunk[];
}

async function search_docs_dsfr(
  query: string,
  top_k = 5,
): Promise<Array<DocChunk & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(query, queryVec, matrix!, bm25, indexEntries!, DIMS, top_k);
}

async function get_doc_dsfr_page(docPath: string): Promise<string> {
  const fullPath = path.join(DOCS_DIR, docPath);
  if (!fs.existsSync(fullPath))
    return `Erreur: la page "${docPath}" n'existe pas. Utilise uniquement les chemins retournés par search_docs_dsfr.`;
  return fs.readFileSync(fullPath, "utf-8");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchDocsDsfrTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_docs_dsfr",
    description:
      "Recherche dans la documentation du Design Système de l'État (DSFR) sur systeme-de-design.gouv.fr. À utiliser pour toute question sur le DSFR, les composants UI, l'accessibilité, les guidelines de design, les fondamentaux graphiques, les premiers pas avec le système de design. Utilise get_doc_dsfr_page pour récupérer le contenu complet d'un résultat.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'comment utiliser les boutons du DSFR'",
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

const getDocDsfrPageTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_doc_dsfr_page",
    description:
      "Récupère le contenu complet d'une page de documentation DSFR par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_dsfr.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Chemin relatif retourné par search_docs_dsfr (ex: premiers-pas/installation.md)",
        },
      },
      required: ["path"],
    },
  },
};

export const tools = [searchDocsDsfrTool, getDocDsfrPageTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_docs_dsfr: (args) =>
    search_docs_dsfr(args["query"] as string, (args["top_k"] as number) ?? 5),
  get_doc_dsfr_page: (args) => get_doc_dsfr_page(args["path"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}

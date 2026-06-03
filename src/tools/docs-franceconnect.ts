import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const DOCS_DIR = path.join(DATA, "docs-franceconnect");
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
  matrix = loadBin(path.join(DATA, "docs-franceconnect", "docs.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(DATA, "docs-franceconnect", "docs.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(DATA, "docs-franceconnect", "docs.index.json"), "utf-8"),
  ) as DocChunk[];
}

async function search_docs_franceconnect(
  query: string,
  top_k = 5,
): Promise<Array<DocChunk & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(query, queryVec, matrix!, bm25, indexEntries!, DIMS, top_k);
}

async function get_doc_franceconnect_page(docPath: string): Promise<string> {
  const fullPath = path.join(DOCS_DIR, docPath);
  if (!fs.existsSync(fullPath))
    return `Erreur: la page "${docPath}" n'existe pas. Utilise uniquement les chemins retournés par search_docs_franceconnect.`;
  return fs.readFileSync(fullPath, "utf-8");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchDocsFranceconnectTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_docs_franceconnect",
    description:
      "Recherche dans la documentation FranceConnect (docs.partenaires.franceconnect.gouv.fr). À utiliser pour toute question sur FranceConnect, l'intégration SSO, la fédération d'identité, l'authentification des citoyens. Utilise get_doc_franceconnect_page pour récupérer le contenu complet d'un résultat.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'comment intégrer FranceConnect sur mon service'",
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

const getDocFranceconnectPageTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_doc_franceconnect_page",
    description:
      "Récupère le contenu complet d'une page de documentation FranceConnect par son chemin relatif. À utiliser UNIQUEMENT avec les chemins retournés par search_docs_franceconnect.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Chemin relatif retourné par search_docs_franceconnect (ex: integration-fc.md)",
        },
      },
      required: ["path"],
    },
  },
};

export const tools = [searchDocsFranceconnectTool, getDocFranceconnectPageTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_docs_franceconnect: (args) =>
    search_docs_franceconnect(args["query"] as string, (args["top_k"] as number) ?? 5),
  get_doc_franceconnect_page: (args) =>
    get_doc_franceconnect_page(args["path"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}

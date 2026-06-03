import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

export interface DocChunk {
  path: string;
  title: string;
  breadcrumb: string;
  excerpt: string;
}

export interface DocToolOpts {
  dir: string;
  searchName: string;
  pageName: string;
  searchDescription: string;
  pageDescription: string;
  searchExample: string;
  pageExample: string;
  postProcess?: (content: string) => string;
}

export function makeDocsTool(opts: DocToolOpts): {
  tools: ChatCompletionTool[];
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  reset: () => void;
} {
  const DIMS = config.openai.embedDims;

  let matrix: Float32Array | null = null;
  let bm25: unknown = null;
  let indexEntries: DocChunk[] | null = null;

  async function ensureLoaded() {
    if (matrix) return;
    matrix = loadBin(path.join(opts.dir, "docs.embeddings.bin"), DIMS);
    bm25 = await loadBM25Index(path.join(opts.dir, "docs.bm25.json"));
    indexEntries = JSON.parse(
      fs.readFileSync(path.join(opts.dir, "docs.index.json"), "utf-8"),
    ) as DocChunk[];
  }

  async function search(
    query: string,
    top_k = 5,
  ): Promise<Array<DocChunk & { score: number }>> {
    await ensureLoaded();
    const queryVec = await embedText(query);
    return hybridSearch(query, queryVec, matrix!, bm25, indexEntries!, DIMS, top_k);
  }

  async function getPage(docPath: string): Promise<string> {
    const fullPath = path.join(opts.dir, docPath);
    if (!fs.existsSync(fullPath))
      return `Erreur: la page "${docPath}" n'existe pas. Utilise uniquement les chemins retournés par ${opts.searchName}.`;
    const content = fs.readFileSync(fullPath, "utf-8");
    return opts.postProcess ? opts.postProcess(content) : content;
  }

  const searchTool: ChatCompletionTool = {
    type: "function",
    function: {
      name: opts.searchName,
      description: opts.searchDescription,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: `Requête en langage naturel, ex: '${opts.searchExample}'`,
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

  const pageTool: ChatCompletionTool = {
    type: "function",
    function: {
      name: opts.pageName,
      description: opts.pageDescription,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Chemin relatif retourné par ${opts.searchName} (ex: ${opts.pageExample})`,
          },
        },
        required: ["path"],
      },
    },
  };

  return {
    tools: [searchTool, pageTool],
    handlers: {
      [opts.searchName]: (args) =>
        search(args["query"] as string, (args["top_k"] as number) ?? 5),
      [opts.pageName]: (args) => getPage(args["path"] as string),
    },
    reset() {
      matrix = null;
      bm25 = null;
      indexEntries = null;
    },
  };
}

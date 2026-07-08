import fs from "fs";
import path from "path";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";
import { embedText, loadBin } from "../embed.js";
import { loadBM25Index, hybridSearch } from "../search.js";

const DATA = config.dataDir;
const JOBS_DIR = path.join(DATA, "choisirleservicepublic");
const DIMS = config.openai.embedDims;

interface JobChunk {
  title: string;
  link: string;
  categories: string[];
  pubDate: string;
  excerpt: string;
}

interface JobItem {
  title: string;
  link: string;
  description: string;
  categories: string[];
  pubDate: string;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Lazy-loaded search indices
let matrix: Float32Array | null = null;
let bm25: unknown = null;
let indexEntries: JobChunk[] | null = null;

async function ensureLoaded() {
  if (matrix) return;
  matrix = loadBin(path.join(JOBS_DIR, "jobs.embeddings.bin"), DIMS);
  bm25 = await loadBM25Index(path.join(JOBS_DIR, "jobs.bm25.json"));
  indexEntries = JSON.parse(
    fs.readFileSync(path.join(JOBS_DIR, "jobs.index.json"), "utf-8"),
  ) as JobChunk[];
}

async function search_choisirleservicepublic_jobs(
  query: string,
  top_k = 5,
): Promise<Array<JobChunk & { score: number }>> {
  await ensureLoaded();
  const queryVec = await embedText(query);
  return hybridSearch(query, queryVec, matrix!, bm25, indexEntries!, DIMS, top_k);
}

async function get_choisirleservicepublic_job_detail(
  link: string,
): Promise<Record<string, unknown> | null> {
  if (!fs.existsSync(JOBS_DIR)) return null;

  const files = fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "jobs.index.json");

  for (const file of files) {
    let items: JobItem[];
    try {
      items = JSON.parse(
        fs.readFileSync(path.join(JOBS_DIR, file), "utf-8"),
      ) as JobItem[];
    } catch {
      continue;
    }
    const item = items.find((i) => i.link === link);
    if (item) {
      return {
        title: item.title,
        link: item.link,
        categories: item.categories,
        pubDate: item.pubDate,
        description: stripHtml(item.description ?? ""),
      };
    }
  }

  return null;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const searchJobsTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_choisirleservicepublic_jobs",
    description:
      "Recherche des offres d'emploi de la fonction publique sur choisirleservicepublic.gouv.fr par intitulé de poste, métier, compétences ou localisation. Utilise get_choisirleservicepublic_job_detail pour récupérer le détail complet d'une offre.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Requête en langage naturel, ex: 'technicien chimiste Rouen' ou 'développeur informatique contractuel'",
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

const getJobDetailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_choisirleservicepublic_job_detail",
    description:
      "Récupère le détail complet d'une offre d'emploi choisirleservicepublic.gouv.fr par son URL. À utiliser UNIQUEMENT avec les liens retournés par search_choisirleservicepublic_jobs.",
    parameters: {
      type: "object",
      properties: {
        link: {
          type: "string",
          description:
            "URL de l'offre, issue de search_choisirleservicepublic_jobs (champ link)",
        },
      },
      required: ["link"],
    },
  },
};

export const tools = [searchJobsTool, getJobDetailTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  search_choisirleservicepublic_jobs: (args) =>
    search_choisirleservicepublic_jobs(
      args["query"] as string,
      (args["top_k"] as number) ?? 5,
    ),
  get_choisirleservicepublic_job_detail: (args) =>
    get_choisirleservicepublic_job_detail(args["link"] as string),
};

export function reset(): void {
  matrix = null;
  bm25 = null;
  indexEntries = null;
}

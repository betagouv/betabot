import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

const DB_PATH = path.join(config.dataDir, "betabot.db");

const SCHEMA = `
Tables:
  members(id, fullname, domaine, role, created_at)  -- created_at: date de la première mission (YYYY-MM-DD)
  member_competences(member_id, competence)
  incubators(id, title, contact, website)
  startups(id, name, pitch, incubator_id, active_member_count, current_phase, accessibility_status, created_at)
    created_at: date de la première phase (YYYY-MM-DD)
    current_phase: dernière phase (ex: 'investigation', 'construction', 'acceleration', 'transfere', 'abandon', 'abandon-investigation'…)
    accessibility_status: 'conforme'|'non conforme'|'partiellement conforme'|null
  startup_phases(startup_id, name, start_date, end_date)
  startup_members(startup_id, member_id, status)
    status: 'active'|'previous'|'expired'
  startup_thematiques(startup_id, thematique)
  startup_technos(startup_id, techno)
`;

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
  }
  return _db;
}

async function query_data(sql: string): Promise<unknown> {
  const normalized = sql.trim().replace(/\s+/g, " ").toUpperCase();
  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
    return { error: "Only SELECT (or WITH … SELECT) queries are allowed." };
  }
  try {
    const stmt = getDb().prepare(sql);
    const rows = stmt.all() as unknown[];
    return rows.slice(0, 200);
  } catch (err) {
    return { error: String(err) };
  }
}

const queryDataTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "query_data",
    description:
      `Exécute une requête SQL SELECT sur la base de données locale pour répondre aux questions statistiques ou d'agrégation : compter, classer, grouper des membres, startups, incubateurs, compétences, phases, thématiques, technologies.
Préférer cet outil aux outils de recherche sémantique pour les questions du type "combien de…", "quelle startup a le plus…", "quelles compétences sont les plus représentées", "liste des startups en phase X", "startups de l'incubateur Y".
Retourne au maximum 200 lignes.
${SCHEMA}`,
    parameters: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "Requête SQL SELECT ou WITH…SELECT.",
        },
      },
      required: ["sql"],
    },
  },
};

export const tools = [queryDataTool];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  query_data: (args) => query_data(args["sql"] as string),
};

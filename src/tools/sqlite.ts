import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

const DB_PATH = path.join(config.dataDir, "betabot.db");

// TODO: dynamic
const SCHEMA = `
Tables:
  members(id, fullname, domaine, role, created_at)
    created_at: date de la première mission (YYYY-MM-DD)
    domaine: 'Produit'|'Développement'|'Autre'|'Animation'|'Intraprenariat'|'Attributaire'|'Support'|'Data'|'Coaching'|'Déploiement'|'Design'
  member_competences(member_id, competence)
  incubators(id, title, contact, website)
  startups(id, name, pitch, incubator_id, incubator, active_member_count, current_phase, accessibility_status, created_at)
    incubator: nom lisible de l'incubateur : 'L\'incubateur de l'Éducation nationale et de la Jeunesse'|'La Ruche numérique - l\'Incubateur du Ministère de l\'Agriculture et de la Souveraineté alimentaire'|'La Fabrique Numérique de l\'Ecologie (MTE)'|'L\'Incubateur de la Justice'|'Le département Accompagnement de services numériques de la DINUM'|'L\'Incubateur des Territoires (ANCT)'|'Accélérema'|'Le KUBE, incubateur du ministère des Armées'|'ALLiaNCE'|'L\'Accélérateur de la Transition Écologique (ADEME)'|'Opérateur de produits interministériels'|'L'Incubateur de France travail'|'Mission interministérielle pour l\’apprentissage'|'L'Atelier Numérique du Ministère de la Culture'|'La Fabrique Numérique du Ministère de l\'Intérieur'|'La Fabrique numérique des Finances publiques'|'La Fabrique de la donnée territoriale'|'L\'Atelier Numérique du Ministère de l\'Europe et des Affaires Etrangères'|'Plateforme de l\'inclusion'|'Le laboratoire d\'innovation de l\'ANSSI'|'Incubateur du MEFR (Bercy)'
    created_at: date de la première phase (YYYY-MM-DD)
    current_phase: dernière phase : 'investigation'|'construction'|'acceleration'|'transfere'|'abandon'|'abandon-investigation'|'opere'
    accessibility_status: 'conforme'|'non conforme'|'partiellement conforme'|null
  startup_phases(startup_id, name, start_date, end_date)
  startup_members(startup_id, member_id, status)
    status: active|previous|expired
  startup_thematiques(startup_id, thematique)
    thematique: 'Écologie'|'Administratif'|'Territoires'|'Travail / Emploi'|'Collectivités'|'Open-Data'|'Outil technique'|'Social'|'Jeunesse'|'Agriculture'|'Formation'|'Santé'|'Logement'|'Justice'|'Entreprises'|'Inclusion numérique'|'Démocratie'|'Transports'|'Patrimoine'|'Education'|'Sécurité informatique'|'Mer'|'Culture'|'cybersécurité'|'Sport'|'Intelligence artificielle'
  startup_technos(startup_id, techno)
    techno: 'angular'|'css'|'django'|'docker'|'express'|'fastapi'|'flask'|'git'|'grist'|'html'|'java'|'javascript'|'kubernetes'|'LLM'|'MDX'|'mongodb'|'next.js'|'NodeJS'|'php'|'PostgreSQL'|'publi.codes'|'Python'|'rails'|'React'|'ruby'|'sql'|'symfony'|'tailwindcss'|'terraform'|'TypeScript'|'vue'
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
    description: `Exécute une requête SQL SELECT sur la base de données locale pour répondre aux questions statistiques ou d'agrégation : compter, classer, grouper des membres, startups, incubateurs, compétences, phases, thématiques, technologies.
Préférer cet outil aux outils de recherche sémantique pour les questions du type "combien de…", "quelle startup a le plus…", "quelles compétences sont les plus représentées", "liste des startups en phase X", "startups de l'incubateur Y".
Utilise des opérateurs insensibles à la casse et retourne au maximum 200 lignes.
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

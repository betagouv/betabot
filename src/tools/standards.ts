import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { config } from "../config.js";

const DB_PATH = path.join(config.dataDir, "betabot.db");

const CATEGORIES = [
  "accessibilité",
  "design",
  "impact",
  "qualité-du-support",
  "qualité-logicielle",
  "sécurité",
  "transparence",
  "vie-privée",
  "équipe",
] as const;

// Startup phases that are actively incubated and therefore expected to
// maintain an evaluation of the standards (investigation is too early,
// transfere consorts are out of incubation).
const ACTIVE_PHASES = ["construction", "acceleration", "consolidation", "opere"];

type Category = (typeof CATEGORIES)[number];

interface EvalRow {
  startup_id: string;
  category: string;
  completion: number | null;
  conformity: number | null;
}

interface StartupMeta {
  id: string;
  name: string;
  current_phase: string;
  incubator_id: string | null;
  incubator: string | null;
}

let _db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH, { readOnly: true });
  }
  return _db;
}

function readEvaluations(): Map<string, Map<string, EvalRow>> {
  const rows = getDb()
    .prepare("SELECT startup_id, category, completion, conformity FROM standards_evaluations")
    .all() as unknown as EvalRow[];
  const byStartup = new Map<string, Map<string, EvalRow>>();
  for (const row of rows) {
    let inner = byStartup.get(row.startup_id);
    if (!inner) {
      inner = new Map();
      byStartup.set(row.startup_id, inner);
    }
    inner.set(row.category, row);
  }
  return byStartup;
}

function readStartups(): Map<string, StartupMeta> {
  const rows = getDb()
    .prepare(
      "SELECT id, name, current_phase, incubator_id, incubator FROM startups",
    )
    .all() as unknown as StartupMeta[];
  const map = new Map<string, StartupMeta>();
  for (const row of rows) map.set(row.id, row);
  return map;
}

function readThematiques(ids: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT startup_id, thematique FROM startup_thematiques WHERE startup_id IN (${placeholders})`,
    )
    .all(...ids) as unknown as Array<{ startup_id: string; thematique: string }>;
  for (const row of rows) {
    const list = map.get(row.startup_id) ?? [];
    list.push(row.thematique);
    map.set(row.startup_id, list);
  }
  return map;
}

function average(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === "number");
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

function globalCompletion(rowMap: Map<string, EvalRow>): number | null {
  const vals = CATEGORIES.map((c) => rowMap.get(c)?.completion ?? null);
  return average(vals);
}

const INCUBATION_HELP = `Cette startup n'a pas d'évaluation des standards beta.gouv.fr enregistrée localement.

Pour la mettre à jour :
1. Rendez-vous sur https://standards.beta.gouv.fr et créez/connectez-vous à un compte.
2. Rejoignez l'équipe de la startup (ou demandez à un membre existant de vous ajouter).
3. Répondez aux critères des 9 catégories (sécurité, accessibilité, vie privée, qualité logicielle…).
4. Une fois l'évaluation enregistrée, elle sera récupérée au prochain rafraîchissement des données.`;

// ─── Tool 1: single startup evaluation ───────────────────────────────────────

async function get_startup_standards_evaluation(
  startup_id: string,
): Promise<unknown> {
  const byStartup = readEvaluations();
  const rowMap = byStartup.get(startup_id);
  if (!rowMap || rowMap.size === 0) {
    return { startup_id, evaluated: false, message: INCUBATION_HELP };
  }
  const scores: Record<string, unknown> = {};
  for (const cat of CATEGORIES) {
    const row = rowMap.get(cat);
    scores[cat] = row
      ? { completion: row.completion, conformity: row.conformity }
      : { completion: null, conformity: null };
  }
  return {
    startup_id,
    evaluated: true,
    global_completion: globalCompletion(rowMap),
    scores,
  };
}

// ─── Tool 2: coverage / aggregates ───────────────────────────────────────────

async function list_standards_coverage(params: {
  incubator?: string;
  thematique?: string;
  category?: string;
}): Promise<unknown> {
  const byStartup = readEvaluations();
  const startups = readStartups();

  const incubatorFilter = params.incubator
    ? params.incubator.toLowerCase()
    : null;
  const thematiqueFilter = params.thematique
    ? params.thematique.toLowerCase()
    : null;
  // Normalize the requested category: case/whitespace-insensitive, so
  // "securite", "Sécurité", "securite " all match "sécurité".
  const categoryFilter = params.category
    ? CATEGORIES.find((c) => c.toLowerCase() === params.category!.trim().toLowerCase())
    : undefined;

  const thematiques = thematiqueFilter
    ? readThematiques([...startups.keys()])
    : new Map<string, string[]>();

  function matches(startupId: string, meta: StartupMeta): boolean {
    if (incubatorFilter) {
      const inc = (meta.incubator ?? meta.incubator_id ?? "").toLowerCase();
      if (!inc.includes(incubatorFilter)) return false;
    }
    if (thematiqueFilter) {
      const ths = (thematiques.get(startupId) ?? []).map((t) =>
        t.toLowerCase(),
      );
      if (!ths.some((t) => t.includes(thematiqueFilter))) return false;
    }
    return true;
  }

  const evaluated = [...byStartup.keys()].filter((id) =>
    matches(id, startups.get(id) ?? EMPTY_META(id)),
  );

  const notEvaluated = [...startups.entries()]
    .filter(
      ([id, meta]) =>
        ACTIVE_PHASES.includes(meta.current_phase) &&
        !byStartup.has(id) &&
        matches(id, meta),
    )
    .map(([id, meta]) => ({ id, name: meta.name, incubator: meta.incubator }));

  // per-category average over evaluated startups (of the filtered population)
  const categoryAverages: Record<string, number | null> = {};
  for (const cat of CATEGORIES) {
    const vals = evaluated.map((id) => byStartup.get(id)!.get(cat)?.completion ?? null);
    categoryAverages[cat] = average(vals);
  }

  const global = average(
    evaluated.map((id) => globalCompletion(byStartup.get(id)!)),
  );

  // per-incubator averages
  const incGroups = new Map<string, Array<number | null>>();
  for (const id of evaluated) {
    const meta = startups.get(id);
    const key = meta?.incubator ?? meta?.incubator_id ?? "inconnu";
    const g = incGroups.get(key) ?? [];
    g.push(globalCompletion(byStartup.get(id)!));
    incGroups.set(key, g);
  }
  const incubatorAverages: Array<{ incubator: string; average: number | null; count: number }> =
    [...incGroups.entries()]
      .map(([incubator, vals]) => ({
        incubator,
        average: average(vals),
        count: vals.filter((v) => typeof v === "number").length,
      }))
      .sort((a, b) => (b.average ?? -1) - (a.average ?? -1));

  return {
    population: ACTIVE_PHASES,
    filter: {
      incubator: params.incubator ?? null,
      thematique: params.thematique ?? null,
      category: categoryFilter ?? null,
    },
    summary: {
      evaluated_count: evaluated.length,
      not_evaluated_count: notEvaluated.length,
      global_completion_average: global,
    },
    category_averages: categoryAverages,
    incubator_averages: incubatorAverages,
    // When a specific category is requested, break down every evaluated
    // startup of the population by its completion in that category, worst
    // first — lets the LLM answer "qui n'a pas avancé sur la catégorie X ?".
    by_category: categoryFilter
      ? evaluated
          .map((id) => {
            const meta = startups.get(id) ?? EMPTY_META(id);
            const val = byStartup.get(id)!.get(categoryFilter) ?? null;
            return {
              startup_id: id,
              name: meta.name,
              incubator: meta.incubator,
              completion: val?.completion ?? null,
              conformity: val?.conformity ?? null,
            };
          })
          .sort(
            (a, b) =>
              (a.completion ?? -1) - (b.completion ?? -1) ||
              (a.conformity ?? -1) - (b.conformity ?? -1),
          )
      : undefined,
    evaluated,
    not_evaluated: notEvaluated,
  };
}

function EMPTY_META(id: string): StartupMeta {
  return { id, name: id, current_phase: "", incubator_id: null, incubator: null };
}

// ─── Tool 3: markdown report ─────────────────────────────────────────────────

async function standards_report(params: {
  incubator?: string;
  thematique?: string;
  category?: string;
}): Promise<string> {
  const byStartup = readEvaluations();
  const startups = readStartups();
  const coverage = (await list_standards_coverage(params)) as {
    evaluated: string[];
    not_evaluated: Array<{ id: string; name: string; incubator: string | null }>;
    category_averages: Record<string, number | null>;
    incubator_averages: Array<{ incubator: string; average: number | null; count: number }>;
    summary: { global_completion_average: number | null };
    by_category?: Array<{
      startup_id: string;
      name: string;
      incubator: string | null;
      completion: number | null;
      conformity: number | null;
    }>;
  };
  const categoryFilter = params.category
    ? CATEGORIES.find((c) => c.toLowerCase() === params.category!.trim().toLowerCase())
    : undefined;

  const lines: string[] = [];
  const title = [
    "Niveau des standards beta.gouv.fr",
    params.incubator ? ` — ${params.incubator}` : "",
    params.thematique ? ` — ${params.thematique}` : "",
    categoryFilter ? ` — catégorie ${categoryFilter}` : "",
  ].join("");
  lines.push(`### ${title}`);
  lines.push("");

  // Global
  lines.push(
    `**Moyenne globale (completion) :** ${coverage.summary.global_completion_average ?? "—"}%`,
  );
  lines.push("");

  // When a specific category is requested, rank startups by progress in that
  // category (worst first) so "qui n'a pas avancé ?" is answered directly.
  if (categoryFilter && coverage.by_category) {
    lines.push(`#### Avancement sur « ${categoryFilter} » (completion %)`);
    lines.push("");
    lines.push("| Rang | Startup | Completion | Conformity | Incubateur |");
    lines.push("| --- | --- | --- | --- | --- |");
    coverage.by_category.forEach((s, i) => {
      lines.push(
        `| ${i + 1} | ${s.name} | ${fmt(s.completion)}% | ${fmt(s.conformity)}% | ${s.incubator ?? "—"} |`,
      );
    });
    lines.push("");
  }

  // Detailed table: startup x category
  if (coverage.evaluated.length) {
    lines.push("#### Détail par startup (completion %)");
    lines.push("");
    const header = `| Startup | ${CATEGORIES.map((c) => shortLabel(c)).join(" | ")} | Moy. |`;
    const sep = `| --- | ${CATEGORIES.map(() => "---").join(" | ")} | --- |`;
    lines.push(header, sep);
    const ordered = [...coverage.evaluated].sort((a, b) => {
      const ga = globalCompletion(byStartup.get(a)!) ?? -1;
      const gb = globalCompletion(byStartup.get(b)!) ?? -1;
      return gb - ga;
    });
    for (const id of ordered) {
      const meta = startups.get(id);
      const rowMap = byStartup.get(id)!;
      const cells = CATEGORIES.map((c) =>
        fmt(rowMap.get(c)?.completion),
      );
      lines.push(
        `| ${meta?.name ?? id} | ${cells.join(" | ")} | ${fmt(globalCompletion(rowMap))} |`,
      );
    }
    lines.push("");
  }

  // Averages per incubator
  if (coverage.incubator_averages.length) {
    lines.push("#### Moyennes par incubateur");
    lines.push("");
    lines.push("| Incubateur | Moyenne (completion) | Évaluées |");
    lines.push("| --- | --- | --- |");
    for (const inc of coverage.incubator_averages) {
      lines.push(
        `| ${inc.incubator} | ${fmt(inc.average)}% | ${inc.count} |`,
      );
    }
    lines.push("");
  }

  // Category averages
  const catLine = CATEGORIES.map(
    (c) => `${shortLabel(c)}: ${fmt(coverage.category_averages[c])}%`,
  ).join(" · ");
  lines.push(`**Moyennes par catégorie :** ${catLine}`);
  lines.push("");

  // Not evaluated
  if (coverage.not_evaluated.length) {
    lines.push(`#### Non évaluées (${coverage.not_evaluated.length})`);
    lines.push("");
    for (const s of coverage.not_evaluated) {
      lines.push(`- ${s.name} (${s.incubator ?? "incubateur inconnu"})`);
    }
    lines.push("");
    lines.push(
      `Pour évaluer une startup manquante : https://standards.beta.gouv.fr .`,
    );
  }

  lines.push("---");
  lines.push(
    `Source : [standards des produits beta.gouv.fr](https://standards.beta.gouv.fr) · métrique = completion (%)`,
  );
  return lines.join("\n");
}

function shortLabel(c: string): string {
  const map: Record<string, string> = {
    accessibilité: "Access.",
    impact: "Impact",
    "qualité-du-support": "Support",
    "qualité-logicielle": "Qual. log.",
    sécurité: "Sécurité",
    transparence: "Transparence",
    "vie-privée": "Vie privée",
    équipe: "Équipe",
    design: "Design",
  };
  return map[c] ?? c;
}

function fmt(v: number | null | undefined): string {
  if (v == null) return "—";
  return String(Math.round(v * 10) / 10);
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const getStartupEvaluationTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_startup_standards_evaluation",
    description:
      "Récupère le niveau des standards beta.gouv.fr d'une startup précise par son slug (ex: recosante). Retourne completion et conformity par catégorie (sécurité, accessibilité, vie privée, qualité logicielle…). Si la startup n'a pas d'évaluation, explique comment s'inscrire et évaluer sur standards.beta.gouv.fr.",
    parameters: {
      type: "object",
      properties: {
        startup_id: {
          type: "string",
          description: "Slug de la startup (ex: domifa)",
        },
      },
      required: ["startup_id"],
    },
  },
};

const listCoverageTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "list_standards_coverage",
    description:
      "Renseigne l'état des évaluations standards des startups : startups évaluées, startups incubées actives NON évaluées, moyennes de completion par catégorie et par incubateur. Appel pour les questions du type « quelles startups n'ont pas rempli les standards ? », « lesquelles sont non évaluées sur l'écologie ? », « quel est le niveau moyen par incubateur ? ». Filtrable par incubateur (nom) et/ou thématique (ex: Écologie). Si on demande une catégorie précise (ex: « qui n'a pas avancé sur la sécurité ? »), passer le paramètre category : la réponse contient alors le détail par catégorie (completion/conformity) rangé des plus faibles aux plus forts.",
    parameters: {
      type: "object",
      properties: {
        incubator: {
          type: "string",
          description:
            "Filtre optionnel par incubateur (nom, ex: Fabrique Numérique de l'Ecologie, DINUM, Bercy…).",
        },
        thematique: {
          type: "string",
          description: "Filtre optionnel par thématique de startup (ex: Écologie, Santé, Justice…).",
        },
        category: {
          type: "string",
          description:
            "Filtre optionnel par catégorie de standards (ex: sécurité, accessibilité, vie-privée, qualité-logicielle, design, impact, transparence, qualité-du-support, équipe). À passer pour « qui n'a pas avancé sur la catégorie X ? ».",
        },
      },
    },
  },
};

const reportTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "standards_report",
    description:
      "Produit un rapport markdown prêt à l'emploi du niveau des standards : tableau détaillé par startup et par catégorie (completion %), moyennes par incubateur, moyennes globales, et liste des startups non évaluées. À privilégier pour « donne-moi un tableau recap du niveau des standards par incubateur et par startup ». Filtrable par incubateur et/ou thématique. Si on passe category (ex: sécurité), le rapport inclut un classement des startups par avancement dans cette catégorie.",
    parameters: {
      type: "object",
      properties: {
        incubator: {
          type: "string",
          description: "Filtre optionnel par incubateur (nom).",
        },
        thematique: {
          type: "string",
          description: "Filtre optionnel par thématique (ex: Écologie).",
        },
        category: {
          type: "string",
          description: "Filtre optionnel par catégorie de standards (ex: sécurité, accessibilité…).",
        },
      },
    },
  },
};

export const tools = [
  getStartupEvaluationTool,
  listCoverageTool,
  reportTool,
];

export const handlers: Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  get_startup_standards_evaluation: (args) =>
    get_startup_standards_evaluation(args["startup_id"] as string),
  list_standards_coverage: (args) =>
    list_standards_coverage({
      incubator: (args["incubator"] as string) ?? undefined,
      thematique: (args["thematique"] as string) ?? undefined,
      category: (args["category"] as string) ?? undefined,
    }),
  standards_report: (args) =>
    standards_report({
      incubator: (args["incubator"] as string) ?? undefined,
      thematique: (args["thematique"] as string) ?? undefined,
      category: (args["category"] as string) ?? undefined,
    }),
};

export function reset(): void {
  _db?.close();
  _db = null;
}

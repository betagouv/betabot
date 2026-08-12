/**
 * Generates a weekly markdown activity report for one beta.gouv.fr incubator:
 * new startups, startup content changes, new members, and relevant
 * doc.incubateur.net documentation changes.
 *
 * Usage: npx tsx create-report.ts <incubator-slug> [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]
 * Defaults to the last 7 days ending today.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "node:child_process";
import OpenAI from "openai";
import { config } from "./src/config.js";

const DATA = config.dataDir;
const API_DIR = path.join(DATA, "API");
const BETA_GOUV_FR_DIR = path.join(DATA, "beta.gouv.fr");
const DOC_DIR = path.join(DATA, "doc.incubateur.net");
const BETA_GOUV_FR_URL = "https://github.com/betagouv/beta.gouv.fr";
const DOC_REPO_URL =
  "https://github.com/betagouv/doc.incubateur.net-communaute";

interface Phase {
  name: string;
  start: string;
}

interface RawStartupRef {
  id: string;
  name: string;
  pitch: string;
  repository: string | null;
  contact: string;
  phases: Phase[];
}

interface RawIncubator {
  title: string;
  owner: string;
  contact: string;
  address: string | null;
  website: string | null;
  github: string | null;
  startups: RawStartupRef[];
}

interface Mission {
  start: string;
  end: string;
  status: string;
  employer?: string;
  startups?: string[];
}

interface RawMember {
  id: string;
  fullname: string;
  role: string;
  domaine: string;
  link?: string;
  bio?: string;
  github?: string;
  missions: Mission[];
  competences?: string[];
}

// ─── argv parsing ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  slug: string;
  since: string;
  until: string;
} {
  const [slug, ...rest] = argv;
  if (!slug) {
    console.error(
      "Usage: npx tsx create-report.ts <incubator-slug> [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]",
    );
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (const arg of rest) {
    const m = /^--(since|until)=(.+)$/.exec(arg);
    if (m) flags[m[1]!] = m[2]!;
  }

  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(weekAgo.getDate() - 7);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  return {
    slug,
    since: flags["since"] ?? fmt(weekAgo),
    until: flags["until"] ?? fmt(today),
  };
}

// ─── git helpers ────────────────────────────────────────────────────────────

function ensureRepo(dir: string, url: string, depth = 500): void {
  if (fs.existsSync(path.join(dir, ".git"))) {
    execFileSync("git", ["-C", dir, "pull", "--ff-only"], { stdio: "ignore" });
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync("git", ["clone", `--depth=${depth}`, url, dir], {
      stdio: "ignore",
    });
  }
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
}

interface RawStartupDiff {
  id: string;
  diff: string;
}

interface StartupDiff extends RawStartupDiff {
  summary: string;
  addedUrls: string[];
  removedUrls: string[];
}

const URL_RE = /https?:\/\/[^\s)"'<>\]]+/g;

// LLM summaries can paraphrase away the literal URL, so pull changed links
// out of the diff directly to make sure they always surface in the report.
function extractChangedUrls(diff: string): {
  added: string[];
  removed: string[];
} {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      for (const m of line.matchAll(URL_RE)) added.add(m[0]);
    } else if (line.startsWith("-")) {
      for (const m of line.matchAll(URL_RE)) removed.add(m[0]);
    }
  }
  return { added: [...added], removed: [...removed] };
}

function getStartupDiff(
  slug: string,
  since: string,
  until: string,
): RawStartupDiff | null {
  const filePath = `content/_startups/${slug}.md`;
  const log = git(BETA_GOUV_FR_DIR, [
    "log",
    `--since=${since}`,
    `--until=${until} 23:59:59`,
    "--pretty=format:%H",
    "--",
    filePath,
  ]).trim();
  if (!log) return null;

  const commits = log.split("\n");
  const newest = commits[0]!;
  const oldest = commits[commits.length - 1]!;

  try {
    const diff = git(BETA_GOUV_FR_DIR, [
      "diff",
      `${oldest}^..${newest}`,
      "--",
      filePath,
    ]);
    return diff ? { id: slug, diff } : null;
  } catch {
    // oldest has no parent (file was just created within the range)
    const diff = git(BETA_GOUV_FR_DIR, ["show", oldest, "--", filePath]);
    return diff ? { id: slug, diff } : null;
  }
}

interface DocChange {
  hash: string;
  date: string;
  files: string[];
  diff: string;
}

// Cap per-commit so a single mass-deletion/rename commit can't dominate the
// facts sent to the LLM once every doc commit in range is concatenated.
const MAX_DOC_DIFF_CHARS = 1500;

function getDocChanges(since: string, until: string): DocChange[] {
  const log = git(DOC_DIR, [
    "log",
    `--since=${since}`,
    `--until=${until} 23:59:59`,
    "--pretty=format:__COMMIT__%H|%ad",
    "--date=short",
    "--name-only",
  ]);
  if (!log.trim()) return [];

  const blocks = log.split("__COMMIT__").filter(Boolean);
  const changes: DocChange[] = [];

  for (const block of blocks) {
    const [header, ...fileLines] = block.trim().split("\n");
    const [hash, date] = header!.split("|");
    const files = fileLines.filter(Boolean);
    const diff = git(DOC_DIR, ["show", hash!, "--format="]).slice(
      0,
      MAX_DOC_DIFF_CHARS,
    );
    changes.push({ hash: hash!, date: date!, files, diff });
  }

  return changes;
}

// ─── data access ────────────────────────────────────────────────────────────

function loadIncubator(slug: string): RawIncubator {
  const all = JSON.parse(
    fs.readFileSync(path.join(API_DIR, "incubators.json"), "utf-8"),
  ) as Record<string, RawIncubator>;

  const incubator = all[slug];
  if (!incubator) {
    console.error(
      `Unknown incubator "${slug}". Available: ${Object.keys(all).sort().join(", ")}`,
    );
    process.exit(1);
  }
  return incubator;
}

function wasStartupFileCreated(
  id: string,
  since: string,
  until: string,
): boolean {
  const filePath = `content/_startups/${id}.md`;
  const log = git(BETA_GOUV_FR_DIR, [
    "log",
    "--diff-filter=A",
    `--since=${since}`,
    `--until=${until} 23:59:59`,
    "--pretty=format:%H",
    "--",
    filePath,
  ]).trim();
  return log.length > 0;
}

function getNewStartups(
  startups: RawStartupRef[],
  since: string,
  until: string,
): RawStartupRef[] {
  return startups.filter((s) => wasStartupFileCreated(s.id, since, until));
}

interface NewMember {
  member: RawMember;
  startupIds: string[];
}

function getNewMembers(
  startupIds: Set<string>,
  since: string,
  until: string,
): NewMember[] {
  const members = JSON.parse(
    fs.readFileSync(path.join(API_DIR, "members.json"), "utf-8"),
  ) as RawMember[];

  const result: NewMember[] = [];
  for (const member of members) {
    const matched = new Set<string>();
    for (const mission of member.missions ?? []) {
      if (mission.start < since || mission.start > until) continue;
      for (const id of mission.startups ?? []) {
        if (startupIds.has(id)) matched.add(id);
      }
    }
    if (matched.size) result.push({ member, startupIds: [...matched] });
  }
  return result;
}

// ─── markdown rendering ─────────────────────────────────────────────────────

function startupLink(id: string): string {
  return `https://beta.gouv.fr/startups/${id}`;
}

function memberLink(id: string): string {
  return `https://espace-membre.beta.gouv.fr/community/${id}`;
}

function startupNameById(startups: RawStartupRef[], id: string): string {
  return startups.find((s) => s.id === id)?.name ?? id;
}

function getOpenAIClient(): OpenAI {
  return new OpenAI({
    baseURL: config.openai.baseUrl,
    apiKey: config.openai.apiKey,
    timeout: config.openai.timeoutMs,
    maxRetries: 5,
  });
}

async function generateIntro(client: OpenAI, facts: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content:
          "Tu rédiges l'introduction d'un rapport d'activité hebdomadaire pour un incubateur de la communauté beta.gouv.fr, à partir des faits fournis. " +
          "Mets en avant en priorité les nouveautés (nouvelles startups, nouveaux membres) et les changements les plus impactants (chiffres clés, changements de phase, avancées majeures) ; " +
          "les changements mineurs (petits ajustements de contact, de lien, de formulation) peuvent être passés sous silence ou mentionnés brièvement en fin de paragraphe. " +
          "En 2 à 4 phrases, en français. Ton neutre et factuel, sans emphase ni ton commercial. Pas de markdown, pas de titre.",
      },
      { role: "user", content: facts },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

// Diffs can be large (new file, or a heavily edited frontmatter); cap the
// input so a single startup update can't blow up the request.
const MAX_DIFF_CHARS = 8000;

async function summarizeStartupDiff(
  client: OpenAI,
  name: string,
  diff: string,
): Promise<string> {
  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content:
          "Tu résumes un changement apporté à la fiche d'une startup de la communauté beta.gouv.fr " +
          "(fichier content/_startups/*.md : frontmatter YAML — phases, pitch, mission, thematiques, techno, sponsors, etc. — puis texte de présentation). " +
          "À partir du diff git fourni, résume en 1 à 3 phrases courtes et factuelles, en français, ce qui a changé concrètement. " +
          "Ignore les changements de pure forme (réindentation, espaces). Pas de markdown, pas de titre, pas de préambule.",
      },
      {
        role: "user",
        content: `Startup : ${name}\n\nDiff :\n${diff.slice(0, MAX_DIFF_CHARS)}`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "";
}

async function summarizeDocChanges(
  client: OpenAI,
  changes: DocChange[],
): Promise<string> {
  if (!changes.length) return "";

  // Links are built from `changes` ourselves below rather than trusted from
  // the LLM output — long literal strings (full commit URLs) aren't always
  // reproduced verbatim, which would silently produce broken links.
  // The commit subject is intentionally NOT included here: the summary must
  // be derived from the actual diff content, not a paraphrase of the title.
  const facts = changes
    .map(
      (c, i) =>
        `${i + 1}. fichiers: ${c.files.join(", ")}\ndiff:\n${c.diff}`,
    )
    .join("\n\n");

  const response = await client.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content:
          "Tu regroupes par thème une liste numérotée de changements récents sur la documentation de la communauté beta.gouv.fr (doc.incubateur.net). " +
          "Pour chaque changement, base-toi uniquement sur le contenu du diff git fourni (le texte réellement ajouté/supprimé) pour comprendre ce qui a changé — pas de message de commit fourni, n'en invente pas. " +
          "Choisis des thèmes pertinents (ex : recrutement, sécurité, outils, standards, onboarding, etc.). " +
          "Réponds uniquement avec, pour chaque thème, une ligne '### Thème' suivie d'une ligne par changement au format '- N: résumé court en une phrase', " +
          "où N est le numéro exact du changement dans la liste fournie (un seul numéro par ligne, ne fusionne jamais plusieurs numéros sur une même ligne). " +
          "N'invente aucun numéro, aucun lien, aucun texte hors de ce format. Sois factuel et concis, en français.",
      },
      { role: "user", content: facts },
    ],
  });

  const raw = response.choices[0]?.message?.content?.trim() ?? "";
  if (!raw) return "";

  const itemRe = /^-\s*(\d+)\s*:\s*(.+)$/;
  const lines: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("###")) {
      if (lines.length) lines.push("");
      lines.push(line);
      lines.push("");
      continue;
    }
    const m = itemRe.exec(line);
    if (!m) continue; // drop anything that doesn't match the expected format
    const change = changes[parseInt(m[1]!, 10) - 1];
    if (!change) continue; // hallucinated index — drop rather than render a broken link
    const url = `${DOC_REPO_URL}/commit/${change.hash}`;
    lines.push(`- ${m[2]!.trim()} ([${change.date}](${url}))`);
  }

  return lines.join("\n").trim();
}

async function buildReport(
  slug: string,
  since: string,
  until: string,
): Promise<string> {
  const incubator = loadIncubator(slug);
  const startupIds = new Set(incubator.startups.map((s) => s.id));
  const client = getOpenAIClient();

  const newStartups = getNewStartups(incubator.startups, since, until);
  const newStartupIds = new Set(newStartups.map((s) => s.id));

  const rawStartupDiffs: RawStartupDiff[] = [];
  for (const startup of incubator.startups) {
    // New startups are already covered by the "new startups" list above —
    // their only "diff" is the file creation itself, so skip it here.
    if (newStartupIds.has(startup.id)) continue;
    const d = getStartupDiff(startup.id, since, until);
    if (d) rawStartupDiffs.push(d);
  }

  const startupDiffs: StartupDiff[] = [];
  for (const d of rawStartupDiffs) {
    const name = startupNameById(incubator.startups, d.id);
    const summary = await summarizeStartupDiff(client, name, d.diff);
    const { added, removed } = extractChangedUrls(d.diff);
    startupDiffs.push({ ...d, summary, addedUrls: added, removedUrls: removed });
  }

  const newMembers = getNewMembers(startupIds, since, until);

  const docChanges = getDocChanges(since, until);
  const docChangesSummary = await summarizeDocChanges(client, docChanges);

  const facts = [
    `Incubateur : ${incubator.title}`,
    `Période : du ${since} au ${until}`,
    `${newStartups.length} nouvelle(s) startup(s) : ${newStartups.map((s) => s.name).join(", ") || "aucune"}`,
    `${startupDiffs.length} startup(s) mise(s) à jour : ${startupDiffs.map((d) => `${startupNameById(incubator.startups, d.id)} (${d.summary})`).join("; ") || "aucune"}`,
    `${newMembers.length} nouveau(x) membre(s) : ${newMembers.map((m) => m.member.fullname).join(", ") || "aucun"}`,
    `${docChanges.length} changement(s) de documentation beta.gouv.fr`,
  ].join("\n");

  const intro = await generateIntro(client, facts);

  const lines: string[] = [];

  lines.push(`# Activité de ${incubator.title} du ${since} au ${until}`);
  lines.push("");
  lines.push(intro);
  lines.push("");

  lines.push("## Startups");
  lines.push("");
  if (newStartups.length) {
    for (const s of newStartups) {
      lines.push(`- [${s.name}](${startupLink(s.id)}) — ${s.pitch}`);
    }
  } else {
    lines.push("_Aucune nouvelle startup sur la période._");
  }
  lines.push("");

  if (startupDiffs.length) {
    for (const d of startupDiffs) {
      const name = startupNameById(incubator.startups, d.id);
      const historyUrl = `${BETA_GOUV_FR_URL}/commits/master/content/_startups/${d.id}.md`;
      lines.push(`### ${name}`);
      lines.push("");
      lines.push(d.summary || "_Résumé indisponible._");
      lines.push("");
      if (d.removedUrls.length || d.addedUrls.length) {
        lines.push("**URLs modifiées :**");
        for (const url of d.removedUrls) lines.push(`- ~~${url}~~`);
        for (const url of d.addedUrls) lines.push(`- ${url}`);
        lines.push("");
      }
      lines.push(`[Historique des modifications](${historyUrl})`);
      lines.push("");
    }
  } else {
    lines.push("_Aucune modification de fiche startup sur la période._");
    lines.push("");
  }

  lines.push("## Membres");
  lines.push("");
  if (newMembers.length) {
    for (const { member, startupIds: ids } of newMembers) {
      const startupNames = ids
        .map((id) => startupNameById(incubator.startups, id))
        .join(", ");
      const links: string[] = [];
      if (member.link) links.push(member.link);
      if (member.github) links.push(`https://github.com/${member.github}`);
      const parts = [
        `[${member.fullname}](${memberLink(member.id)})`,
        `${member.role} — ${startupNames}`,
      ];
      if (member.bio) parts.push(member.bio);
      if (links.length) parts.push(links.join(", "));
      lines.push(`- ${parts.join(" — ")}`);
    }
  } else {
    lines.push("_Aucun nouveau membre sur la période._");
  }
  lines.push("");

  lines.push("## Documentation beta");
  lines.push("");
  if (docChangesSummary) {
    lines.push(docChangesSummary);
  } else {
    lines.push("_Aucun changement de documentation sur la période._");
  }
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const { slug, since, until } = parseArgs(process.argv.slice(2));

  console.log(`Ensuring repos are up to date...`);
  ensureRepo(BETA_GOUV_FR_DIR, BETA_GOUV_FR_URL);
  ensureRepo(DOC_DIR, DOC_REPO_URL);

  console.log(`Building report for "${slug}" (${since} → ${until})...`);
  const report = await buildReport(slug, since, until);

  const outDir = path.join(DATA, "reports", slug);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${since}_${until}.md`);
  fs.writeFileSync(outPath, report);

  console.log(`Report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

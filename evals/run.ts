import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { config } from "../src/config.js";
import { tools as memberTools } from "../src/tools/members.js";
import { tools as startupTools } from "../src/tools/startups.js";
import { tools as repoTools } from "../src/tools/repos.js";
import { tools as docTools } from "../src/tools/docs.js";
import { tools as proconnectDocTools } from "../src/tools/docs-proconnect.js";
import { tools as franceconnectDocTools } from "../src/tools/docs-franceconnect.js";
import { tools as dsfrDocTools } from "../src/tools/docs-dsfr.js";
import { tools as calendarTools } from "../src/tools/calendar.js";
import { tools as videoTools } from "../src/tools/videos.js";
import { tools as incubatorTools } from "../src/tools/incubators.js";
import { tools as sqliteTools } from "../src/tools/sqlite.js";
import { tools as wttjTools } from "../src/tools/wttj.js";
import { tools as changelogStartupsTools } from "../src/tools/changelog-startups.js";
import { tools as messagerieDocTools } from "../src/tools/docs-messagerie.js";
import { SYSTEM_PROMPT } from "../src/prompt.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions.js";

const ALL_TOOLS: ChatCompletionTool[] = [
  ...memberTools,
  ...startupTools,
  ...repoTools,
  ...docTools,
  ...proconnectDocTools,
  ...franceconnectDocTools,
  ...dsfrDocTools,
  ...calendarTools,
  ...videoTools,
  ...incubatorTools,
  ...sqliteTools,
  ...wttjTools,
  ...changelogStartupsTools,
  ...messagerieDocTools,
];

// Minimal realistic canned responses — enough for the LLM to stop looping.
// We test tool routing, not actual results quality.
const CANNED: Record<string, unknown> = {
  search_members: [
    { id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse", domaine: "Santé", competences: ["Python"], score: 0.9 },
  ],
  search_startups: [
    { id: "test-startup", name: "TestStartup", description: "Service numérique de test.", active_member_count: 3, score: 0.9 },
  ],
  search_docs: [
    { path: "test/doc.md", title: "Documentation test", breadcrumb: "Test", excerpt: "Contenu de test.", score: 0.9 },
  ],
  search_docs_proconnect: [
    { path: "docs-fournisseur-service-bouton-proconnect.md", title: "Bouton ProConnect", breadcrumb: "Fournisseur de service", excerpt: "Intégration du bouton ProConnect.", score: 0.9 },
  ],
  search_docs_franceconnect: [
    { path: "fs-fs-integration-integration-bouton-fc.md", title: "Bouton FranceConnect", breadcrumb: "Fournisseur de service > Intégration", excerpt: "Intégration du bouton FranceConnect.", score: 0.9 },
  ],
  search_docs_dsfr: [
    { path: "premiers-pas/installation.md", title: "Installation du DSFR", breadcrumb: "Premiers pas", excerpt: "Comment installer le Design Système de l'État.", score: 0.9 },
  ],
  get_doc_proconnect_page: "Contenu de la page de documentation ProConnect.",
  get_doc_franceconnect_page: "Contenu de la page de documentation FranceConnect.",
  get_doc_dsfr_page: "Contenu de la page de documentation DSFR.",
  search_repos: [
    { org: "betagouv", repo: "test", name: "test", description: "Repo de test.", score: 0.9 },
  ],
  get_member_detail: { id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse" },
  get_member_startups: [{ startup_id: "test-startup", startup_name: "TestStartup", status: "active" }],
  get_startup_detail: { id: "test-startup", name: "TestStartup", phases: [{ name: "acceleration" }] },
  get_startup_members: [{ id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse" }],
  get_repo_detail: { name: "test", description: "Repo de test.", language: "TypeScript" },
  get_doc_page: "Contenu de la page de documentation.",
  get_page: "Contenu de la page institutionnelle.",
  get_calendar: [{ summary: "Réunion communauté beta.gouv.fr", start: new Date().toISOString() }],
  get_videos: [{ title: "Vidéo communauté", channel: "bluehats", url: "https://tube.numerique.gouv.fr/w/test" }],
  search_incubators: [
    { id: "dinum", name: "DINUM", short_desc: "Incubateur de services numériques de l'État.", score: 0.9 },
  ],
  get_incubator_detail: { id: "dinum", name: "DINUM", startups: [] },
  search_wttj_jobs: [
    { title: "Développeur fullstack", company: "beta.gouv.fr", url: "https://www.welcometothejungle.com/fr/jobs/test", score: 0.9 },
  ],
  get_wttj_job_page: "Contenu de l'offre d'emploi WelcomeKit.",
  search_docs_messagerie: [
    { path: "dmarc.md", title: "DMARC", breadcrumb: "Email > DNS", excerpt: "Configuration DMARC pour votre domaine.", score: 0.9 },
  ],
  get_doc_messagerie_page: "Contenu de la page de documentation messagerie.",
  get_startup_updates: [{ startup_id: "test-startup", summary: "Mise à jour de test." }],
  get_repo_changelog: "Changelog du dépôt de test.",
  get_org_changelog: "Changelog de l'organisation betagouv.",
  query_data: [{ result: 42 }],
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Fixture {
  id: string;
  question: string;
  // All tools that must appear in the call log. Empty array = no tool expected.
  expect_tools: string[];
  expect_first_tool?: string; // if set, the very first tool call must match this name
  // Per-tool arg assertions (checked against the first call of that tool).
  // String values use case-insensitive substring matching; others use strict equality.
  expect_args?: Record<string, Record<string, unknown>>;
}

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface CaseResult {
  id: string;
  question: string;
  expect_tools: string[];
  first_tool: string | null;
  tools: ToolCall[];
  pass: boolean;
  response_chars: number;
}

interface RunResult {
  timestamp: string;
  git: string;
  model: string;
  pass: number;
  total: number;
  cases: CaseResult[];
}

// ─── Arg matching ─────────────────────────────────────────────────────────────

function argsMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(expected)) {
    const got = actual[key];
    if (typeof val === "string" && typeof got === "string") {
      if (!got.toLowerCase().includes(val.toLowerCase())) return false;
    } else {
      if (got !== val) return false;
    }
  }
  return true;
}

// ─── Eval loop ────────────────────────────────────────────────────────────────

async function runCase(
  client: OpenAI,
  question: string
): Promise<{ tools: ToolCall[]; response: string }> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];
  const toolLog: ToolCall[] = [];

  for (let i = 0; i < 5; i++) {
    const resp = await client.chat.completions.create({
      model: config.openai.model,
      messages,
      tools: ALL_TOOLS,
      tool_choice: "auto",
    });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    messages.push(msg as ChatCompletionMessageParam);

    if (!msg.tool_calls?.length) {
      return { tools: toolLog, response: msg.content ?? "" };
    }

    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      toolLog.push({ name: tc.function.name, args });
      const result = CANNED[tc.function.name] ?? { error: `no canned response for ${tc.function.name}` };
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { tools: toolLog, response: "" };
}

// ─── Compare ──────────────────────────────────────────────────────────────────

function findLatest(): string | null {
  const dir = "evals/results";
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

function printDiff(current: RunResult, prevPath: string) {
  if (!fs.existsSync(prevPath)) {
    console.log(`\n⚠ compare file not found: ${prevPath}`);
    return;
  }
  const prev = JSON.parse(fs.readFileSync(prevPath, "utf-8")) as RunResult;
  const prevById = new Map(prev.cases.map((c) => [c.id, c]));

  const regressions = current.cases.filter((c) => !c.pass && prevById.get(c.id)?.pass);
  const improvements = current.cases.filter((c) => c.pass && prevById.has(c.id) && !prevById.get(c.id)!.pass);

  console.log(`\n── vs ${path.basename(prevPath)}  (${prev.model} @ ${prev.git}) ──`);
  if (regressions.length) {
    console.log(`  Regressions (${regressions.length}):`);
    for (const c of regressions) {
      const prev = prevById.get(c.id);
      const wasTools = prev?.tools.map((t) => t.name) ?? [];
      const nowTools = c.tools.map((t) => t.name);
      console.log(`    ✗ ${c.id}`);
      console.log(`        was=[${wasTools.join(", ") || "none"}]  now=[${nowTools.join(", ") || "none"}]`);
    }
  }
  if (improvements.length) {
    console.log(`  Improvements (${improvements.length}):`);
    for (const c of improvements) {
      const prev = prevById.get(c.id);
      const wasTools = prev?.tools.map((t) => t.name) ?? [];
      const nowTools = c.tools.map((t) => t.name);
      console.log(`    ✓ ${c.id}`);
      console.log(`        was=[${wasTools.join(", ") || "none"}]  now=[${nowTools.join(", ") || "none"}]`);
    }
  }
  if (!regressions.length && !improvements.length) console.log("  No routing changes.");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const compareIdx = argv.indexOf("--compare");
  const compareArg = compareIdx !== -1 ? argv[compareIdx + 1] : null;
  const comparePath = compareArg === "latest" ? findLatest() : compareArg;

  const fixturesPath = "evals/fixtures.json";
  if (!fs.existsSync(fixturesPath)) {
    console.error("evals/fixtures.json not found — run: npm run eval:generate");
    process.exit(1);
  }
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf-8")) as Fixture[];

  const client = new OpenAI({ baseURL: config.openai.baseUrl, apiKey: config.openai.apiKey });

  let git = "unknown";
  try { git = execSync("git rev-parse --short HEAD").toString().trim(); } catch { /* no git */ }

  const run: RunResult = {
    timestamp: new Date().toISOString(),
    git,
    model: config.openai.model,
    pass: 0,
    total: fixtures.length,
    cases: [],
  };

  console.log(`betabot eval — ${fixtures.length} cases  model=${run.model}  git=${run.git}\n`);

  for (const fixture of fixtures) {
    process.stdout.write(`  ${fixture.question.slice(0, 52).padEnd(54)}`);
    const { tools, response } = await runCase(client, fixture.question);
    const toolNames = tools.map((t) => t.name);
    const firstTool = toolNames[0] ?? null;
    const toolsMatch = fixture.expect_tools.length === 0
      ? toolNames.length === 0
      : fixture.expect_tools.every((t) => toolNames.includes(t));
    const firstToolMatch = fixture.expect_first_tool
      ? firstTool === fixture.expect_first_tool
      : true;
    const argFailures: string[] = [];
    if (fixture.expect_args) {
      for (const [toolName, expectedArgs] of Object.entries(fixture.expect_args)) {
        const call = tools.find((t) => t.name === toolName);
        if (!call) {
          argFailures.push(`${toolName}(not called)`);
        } else if (!argsMatch(call.args, expectedArgs)) {
          const got = JSON.stringify(call.args);
          const exp = JSON.stringify(expectedArgs);
          argFailures.push(`${toolName} args: expected ${exp} in ${got}`);
        }
      }
    }
    const pass = toolsMatch && firstToolMatch && argFailures.length === 0;
    if (pass) run.pass++;

    run.cases.push({
      id: fixture.id,
      question: fixture.question,
      expect_tools: fixture.expect_tools,
      first_tool: firstTool,
      tools,
      pass,
      response_chars: response.length,
    });

    const gotLabel = toolNames.length ? `[${toolNames.join(", ")}]` : "no tool";
    if (pass) {
      console.log(`✓  ${gotLabel}`);
    } else {
      const exp = fixture.expect_tools.length ? `[${fixture.expect_tools.join(", ")}]` : "none";
      const firstExp = fixture.expect_first_tool ? ` first=${fixture.expect_first_tool}` : "";
      const argExp = argFailures.length ? `  args:${argFailures.join("; ")}` : "";
      console.log(`✗  expected=${exp}${firstExp}  got=${gotLabel}${argExp}`);
    }
  }

  fs.mkdirSync("evals/results", { recursive: true });
  const outFile = `evals/results/${run.timestamp.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outFile, JSON.stringify(run, null, 2));

  console.log(`\n${run.pass}/${run.total} passed — ${outFile}`);

  if (comparePath) printDiff(run, comparePath);
}

main().catch((err) => { console.error(err); process.exit(1); });

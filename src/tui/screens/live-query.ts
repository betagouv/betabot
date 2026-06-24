import { text, select, multiselect, log, note, spinner } from "@clack/prompts";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { config } from "../../config.js";
import { SYSTEM_PROMPT } from "../../prompt.js";
import { tools as memberTools } from "../../tools/members.js";
import { tools as startupTools } from "../../tools/startups.js";
import { tools as repoTools } from "../../tools/repos.js";
import { tools as docTools } from "../../tools/docs.js";
import { tools as proconnectDocTools } from "../../tools/docs-proconnect.js";
import { tools as franceconnectDocTools } from "../../tools/docs-franceconnect.js";
import { tools as dsfrDocTools } from "../../tools/docs-dsfr.js";
import { tools as calendarTools } from "../../tools/calendar.js";
import { tools as videoTools } from "../../tools/videos.js";
import { tools as incubatorTools } from "../../tools/incubators.js";
import { tools as sqliteTools } from "../../tools/sqlite.js";
import { tools as wttjTools } from "../../tools/wttj.js";
import { tools as changelogStartupsTools } from "../../tools/changelog-startups.js";
import { tools as messagerieDocTools } from "../../tools/docs-messagerie.js";
import { Orchestrator } from "../../orchestrator.js";
import type { AppState, ToolCall } from "../types.js";
import { saveFixtures, generateId } from "../data.js";
import { green, dim, bold } from "../ui/colors.js";

const ALL_TOOLS = [
  ...memberTools, ...startupTools, ...repoTools, ...docTools,
  ...proconnectDocTools, ...franceconnectDocTools, ...dsfrDocTools,
  ...calendarTools, ...videoTools, ...incubatorTools, ...sqliteTools,
  ...wttjTools, ...changelogStartupsTools, ...messagerieDocTools,
];

const ALL_TOOL_NAMES = ALL_TOOLS.map((t) => t.function.name);

const CANNED: Record<string, unknown> = {
  search_members: [{ id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse", domaine: "Santé", competences: ["Python"], score: 0.9 }],
  search_startups: [{ id: "test-startup", name: "TestStartup", description: "Service numérique de test.", active_member_count: 3, score: 0.9 }],
  search_docs: [{ path: "test/doc.md", title: "Documentation test", breadcrumb: "Test", excerpt: "Contenu de test.", score: 0.9 }],
  search_docs_proconnect: [{ path: "docs.md", title: "ProConnect", breadcrumb: "Fournisseur", excerpt: "Intégration ProConnect.", score: 0.9 }],
  search_docs_franceconnect: [{ path: "docs.md", title: "FranceConnect", breadcrumb: "Fournisseur", excerpt: "Intégration FranceConnect.", score: 0.9 }],
  search_docs_dsfr: [{ path: "install.md", title: "Installation DSFR", breadcrumb: "Premiers pas", excerpt: "Comment installer le DSFR.", score: 0.9 }],
  get_doc_proconnect_page: "Contenu ProConnect.",
  get_doc_franceconnect_page: "Contenu FranceConnect.",
  get_doc_dsfr_page: "Contenu DSFR.",
  search_repos: [{ org: "betagouv", repo: "test", name: "test", description: "Repo de test.", score: 0.9 }],
  get_member_detail: { id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse" },
  get_member_startups: [{ startup_id: "test-startup", startup_name: "TestStartup", status: "active" }],
  get_startup_detail: { id: "test-startup", name: "TestStartup", phases: [{ name: "acceleration" }] },
  get_startup_members: [{ id: "dupont.marie", fullname: "Marie Dupont", role: "développeuse" }],
  get_repo_detail: { name: "test", description: "Repo de test.", language: "TypeScript" },
  get_doc_page: "Contenu de la page de documentation.",
  get_page: "Contenu de la page institutionnelle.",
  get_calendar: [{ summary: "Réunion communauté beta.gouv.fr", start: new Date().toISOString() }],
  get_videos: [{ title: "Vidéo communauté", channel: "bluehats", url: "https://tube.numerique.gouv.fr/w/test" }],
  search_incubators: [{ id: "dinum", name: "DINUM", short_desc: "Incubateur de l'État.", score: 0.9 }],
  get_incubator_detail: { id: "dinum", name: "DINUM", startups: [] },
  search_wttj_jobs: [{ title: "Développeur fullstack", company: "beta.gouv.fr", url: "https://www.welcometothejungle.com/fr/jobs/test", score: 0.9 }],
  get_wttj_job_page: "Contenu de l'offre d'emploi.",
  search_docs_messagerie: [{ path: "dmarc.md", title: "DMARC", breadcrumb: "Email > DNS", excerpt: "Configuration DMARC.", score: 0.9 }],
  get_doc_messagerie_page: "Contenu messagerie.",
  get_startup_updates: [{ startup_id: "test-startup", summary: "Mise à jour de test." }],
  get_repo_changelog: "Changelog du dépôt de test.",
  get_org_changelog: "Changelog de l'organisation betagouv.",
  query_data: [{ result: 42 }],
};

async function runCanned(question: string): Promise<{ tools: ToolCall[]; response: string }> {
  const client = new OpenAI({ baseURL: config.openai.baseUrl, apiKey: config.openai.apiKey, timeout: config.openai.timeoutMs });
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: question },
  ];
  const toolLog: ToolCall[] = [];

  for (let i = 0; i < 5; i++) {
    const resp = await client.chat.completions.create({ model: config.openai.model, messages, tools: ALL_TOOLS, tool_choice: "auto" });
    const msg = resp.choices[0]?.message;
    if (!msg) break;
    messages.push(msg as ChatCompletionMessageParam);
    if (!msg.tool_calls?.length) return { tools: toolLog, response: msg.content ?? "" };
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      toolLog.push({ name: tc.function.name, args });
      const result = CANNED[tc.function.name] ?? { error: `no canned response for ${tc.function.name}` };
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return { tools: toolLog, response: "" };
}

async function runLive(question: string): Promise<{ tools: ToolCall[]; response: string }> {
  const toolLog: ToolCall[] = [];
  const orch = new Orchestrator();
  const response = await orch.handle({
    userId: "affinate",
    roomId: "affinate",
    text: question,
    onToolCall: (name, args) => { toolLog.push({ name, args }); },
  });
  return { tools: toolLog, response };
}

export async function showLiveQuery(state: AppState): Promise<void> {
  while (true) {
    const mode = await select({
      message: "Query mode",
      options: [
        { value: "canned", label: "Canned  — fast, uses mock tool responses (tests routing only)" },
        { value: "live", label: "Live    — real tool execution (slower, validates full pipeline)" },
        { value: "back", label: "Back to main menu" },
      ],
    });
    if (!mode || mode === "back") return;

    const question = await text({
      message: "Enter a question (in French)",
      placeholder: "qui sait faire du Python ?",
      validate: (v) => (!v.trim() ? "Question cannot be empty" : undefined),
    });
    if (!question || typeof question !== "string") continue;

    const s = spinner();
    s.start(`Querying model (${mode} mode)…`);

    let tools: ToolCall[];
    let response: string;
    try {
      const result = mode === "canned"
        ? await runCanned(question)
        : await runLive(question);
      tools = result.tools;
      response = result.response;
      s.stop("Done");
    } catch (err) {
      s.stop("Error");
      log.error(String(err));
      continue;
    }

    const toolNames = tools.map((t) => t.name);
    const lines = [
      bold("Tool calls: ") + (toolNames.length ? toolNames.map((n) => green(n)).join(", ") : dim("(none)")),
      "",
      bold("Response: ") + dim(`${response.length} chars`),
      response.slice(0, 300) + (response.length > 300 ? dim("…") : ""),
    ];
    note(lines.join("\n"), `Result — ${question.slice(0, 50)}`);

    const saveAction = await select({
      message: "Save as fixture?",
      options: [
        { value: "save", label: "Save as-is (tools above become expect_tools)" },
        { value: "edit", label: "Edit expected tools then save" },
        { value: "no-tool", label: "Save as no-tool-expected fixture" },
        { value: "skip", label: "Discard" },
      ],
    });
    if (!saveAction || saveAction === "skip") continue;

    let expectTools = toolNames;
    if (saveAction === "no-tool") expectTools = [];
    if (saveAction === "edit") {
      const selected = await multiselect({
        message: "Select expected tools",
        options: ALL_TOOL_NAMES.map((name) => ({ value: name, label: name })),
        initialValues: toolNames,
        required: false,
      });
      if (selected && typeof selected !== "symbol") expectTools = selected as string[];
    }

    const id = generateId(question);
    const existing = state.fixtures.find((f) => f.id === id);
    if (existing) {
      log.warn(`Fixture id "${id}" already exists — updating it`);
      existing.expect_tools = expectTools;
      existing.reviewed_at = new Date().toISOString();
    } else {
      state.fixtures.push({ id, question, expect_tools: expectTools });
    }
    saveFixtures(state.fixtures);
    log.success(`Saved fixture: ${id}`);
  }
}

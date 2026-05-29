/**
 * Manual test for the query_data tool.
 * Sends natural language questions to the LLM, runs the SQL it generates against
 * data/betabot.db, and prints the results.
 *
 * Usage: node --env-file=.env --import tsx evals/test-sqlite.ts
 */

import OpenAI from "openai";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.js";
import { tools as sqliteTools } from "../src/tools/sqlite.js";

const QUESTIONS = [
  "quelle startup a le plus de développeurs actifs ?",
  "quelles sont les 10 compétences les plus représentées dans la communauté ?",
  "quelles sont les phases des startups de l'incubateur écologie ?",
  "combien de membres par domaine ?",
  "quelles startups sont en phase construction ?",
  "quelle est la répartition des startups par thématique ?",
];

const client = new OpenAI({ baseURL: config.openai.baseUrl, apiKey: config.openai.apiKey });
const db = new DatabaseSync(config.dataDir + "/betabot.db");

async function runQuestion(question: string): Promise<void> {
  console.log(`\n${"─".repeat(72)}`);
  console.log(`❓ ${question}`);

  const resp = await client.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: "user", content: question }],
    tools: sqliteTools,
    tool_choice: { type: "function", function: { name: "query_data" } },
  });

  const tc = resp.choices[0]?.message.tool_calls?.[0];
  if (!tc) {
    console.log("✗ LLM did not call query_data");
    return;
  }

  const { sql } = JSON.parse(tc.function.arguments) as { sql: string };
  console.log(`🔍 SQL: ${sql}`);

  try {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    console.log(`✓ ${rows.length} row(s)`);
    const preview = rows.slice(0, 5);
    for (const row of preview) {
      console.log("  ", JSON.stringify(row));
    }
    if (rows.length > 5) console.log(`  … (${rows.length - 5} more)`);
  } catch (err) {
    console.log(`✗ SQL error: ${err}`);
  }
}

async function main() {
  console.log(`betabot — test-sqlite  model=${config.openai.model}`);
  for (const q of QUESTIONS) {
    await runQuestion(q);
  }
  db.close();
  console.log(`\n${"─".repeat(72)}`);
  console.log("Done.");
}

main().catch((err) => { console.error(err); process.exit(1); });

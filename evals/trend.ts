/**
 * Shows pass-rate trend across all saved eval runs in evals/results/.
 * Usage: npm run eval:trend
 */
import fs from "fs";
import path from "path";

interface RunResult {
  timestamp: string;
  git: string;
  model: string;
  pass: number;
  total: number;
}

const resultsDir = "evals/results";

if (!fs.existsSync(resultsDir)) {
  console.log("No results yet — run: npm run eval");
  process.exit(0);
}

const files = fs
  .readdirSync(resultsDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (!files.length) {
  console.log("No result files found in evals/results/");
  process.exit(0);
}

const runs: RunResult[] = files.map((f) => {
  return JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf-8")) as RunResult;
});

const pct = (r: RunResult) => ((r.pass / r.total) * 100).toFixed(1);
const badge = (r: RunResult) => {
  const p = r.pass / r.total;
  return p >= 0.9 ? "🟢" : p >= 0.7 ? "🟡" : "🔴";
};

const colW = { date: 24, git: 8, model: 20, score: 10, pct: 6 };
const row = (date: string, git: string, model: string, score: string, p: string, b: string) =>
  `${date.padEnd(colW.date)} ${git.padEnd(colW.git)} ${model.padEnd(colW.model)} ${score.padEnd(colW.score)} ${b} ${p}%`;

console.log(row("date", "git", "model", "pass/total", "%", " "));
console.log("─".repeat(colW.date + colW.git + colW.model + colW.score + colW.pct + 10));

for (const r of runs) {
  const date = new Date(r.timestamp).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
  const score = `${r.pass}/${r.total}`;
  console.log(row(date, r.git, r.model, score, pct(r), badge(r)));
}

console.log(`\n${runs.length} run(s) total`);

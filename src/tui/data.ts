import fs from "fs";
import path from "path";
import type { Fixture, RunResult, ToolStats, CaseResult } from "./types.js";

const FIXTURES_PATH = "evals/fixtures.json";
const RESULTS_DIR = "evals/results";

export function loadFixtures(filePath = FIXTURES_PATH): Fixture[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as Fixture[];
}

export function saveFixtures(fixtures: Fixture[], filePath = FIXTURES_PATH): void {
  fs.writeFileSync(filePath, JSON.stringify(fixtures, null, 2) + "\n");
}

export function loadRuns(dir = RESULTS_DIR): RunResult[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as RunResult);
}

export function indexRunById(run: RunResult): Map<string, CaseResult> {
  return new Map(run.cases.map((c) => [c.id, c]));
}

export function computeToolStats(run: RunResult): ToolStats[] {
  const byTool = new Map<string, { pass: number; fail: number }>();

  for (const c of run.cases) {
    const relevant = c.expect_tools.length > 0 ? c.expect_tools : c.tools.map((t) => t.name);
    for (const tool of relevant) {
      if (!byTool.has(tool)) byTool.set(tool, { pass: 0, fail: 0 });
      const entry = byTool.get(tool)!;
      if (c.pass) entry.pass++;
      else entry.fail++;
    }
  }

  return Array.from(byTool.entries())
    .map(([tool, { pass, fail }]) => ({
      tool,
      total: pass + fail,
      pass,
      fail,
      passRate: (pass + fail) > 0 ? pass / (pass + fail) : 1,
    }))
    .sort((a, b) => a.passRate - b.passRate);
}

export function generateId(question: string, prefix = "manual"): string {
  const slug = question
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${prefix}-${slug}`;
}

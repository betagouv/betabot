import { note, select } from "@clack/prompts";
import type { AppState } from "../types.js";
import { computeToolStats } from "../data.js";
import { sparkline, bar } from "../ui/sparkline.js";
import { green, red, yellow, bold, dim, gray } from "../ui/colors.js";

export async function showDashboard(state: AppState): Promise<void> {
  const { runs, latestRun } = state;

  if (!latestRun) {
    note("No eval runs found.\nRun: npm run eval", "Dashboard");
    return;
  }

  const rates = runs.map((r) => (r.pass / r.total) * 100);
  const spark = sparkline(rates, 30);
  const latest = rates[rates.length - 1]!;
  const prev = rates[rates.length - 2];
  const trend = prev !== undefined ? (latest > prev ? green(" ↑") : latest < prev ? red(" ↓") : dim(" →")) : "";

  const toolStats = computeToolStats(latestRun);
  const failingTools = toolStats.filter((t) => t.fail > 0);
  const passingTools = toolStats.filter((t) => t.fail === 0);

  const lines: string[] = [];

  lines.push(bold("Pass-rate trend") + dim(` (${runs.length} runs)`));
  lines.push(spark + `  ${latest.toFixed(1)}%${trend}`);
  lines.push("");
  lines.push(dim(`Latest: ${latestRun.pass}/${latestRun.total} passed  model=${latestRun.model}  git=${latestRun.git}`));

  if (failingTools.length > 0) {
    lines.push("");
    lines.push(bold("Per-tool failures:"));
    const maxLen = Math.max(...failingTools.map((t) => t.tool.length));
    for (const t of failingTools) {
      const pct = (t.passRate * 100).toFixed(0).padStart(3);
      const b = bar(t.passRate, 10);
      const failStr = red(`${t.fail} fail`);
      lines.push(`  ${t.tool.padEnd(maxLen)}  ${b}  ${pct}%  ${failStr}`);
    }
  }

  if (passingTools.length > 0) {
    lines.push("");
    lines.push(dim(`${passingTools.length} tool(s) at 100%: `) + dim(passingTools.map((t) => t.tool).join(", ")));
  }

  const totalFail = latestRun.total - latestRun.pass;
  lines.push("");
  lines.push(totalFail > 0
    ? yellow(`${totalFail} fixture(s) failing — use Review Queue to fix`)
    : green("All fixtures passing!"));

  note(lines.join("\n"), "Dashboard");

  await select({
    message: "Navigate",
    options: [{ value: "back", label: "Back to main menu" }],
  });
}

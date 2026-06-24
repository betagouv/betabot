import { spawn } from "child_process";
import { confirm, log, note } from "@clack/prompts";
import type { AppState } from "../types.js";
import { loadRuns, loadFixtures } from "../data.js";
import { green, red, dim } from "../ui/colors.js";

export async function showEvalRunner(state: AppState): Promise<void> {
  const ok = await confirm({
    message: `Run eval now? (${state.fixtures.length} fixtures, model=${process.env.OPENAI_MODEL ?? "default"})`,
  });
  if (!ok) return;

  console.log(dim("\n── eval output ────────────────────────────────────────\n"));

  await new Promise<void>((resolve) => {
    const child = spawn(
      "node",
      ["--env-file=.env", "--import", "tsx/esm", "evals/run.ts"],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    let passCount = 0;
    let failCount = 0;

    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line.includes("✓")) passCount++;
        if (line.includes("✗")) failCount++;
        process.stdout.write(line + (line ? "\n" : ""));
      }
    });

    child.on("close", (code) => {
      console.log(dim("\n────────────────────────────────────────────────────────\n"));
      if (code === 0) {
        log.success(`Eval complete: ${green(`${passCount} pass`)} / ${failCount > 0 ? red(`${failCount} fail`) : "0 fail"}`);
      } else {
        log.error(`Eval exited with code ${code}`);
      }
      // Reload state with new results
      state.runs = loadRuns();
      state.latestRun = state.runs[state.runs.length - 1] ?? null;
      state.fixtures = loadFixtures();
      resolve();
    });

    child.on("error", (err) => {
      log.error(`Failed to spawn eval: ${err.message}`);
      resolve();
    });
  });

  if (state.latestRun) {
    const r = state.latestRun;
    note(
      `${r.pass}/${r.total} passed (${((r.pass / r.total) * 100).toFixed(1)}%)\nmodel=${r.model}  git=${r.git}`,
      "Latest result"
    );
  }
}

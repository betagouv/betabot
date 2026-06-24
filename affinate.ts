#!/usr/bin/env node
import { intro, outro, select, isCancel } from "@clack/prompts";
import { loadFixtures, loadRuns } from "./src/tui/data.js";
import { showDashboard } from "./src/tui/screens/dashboard.js";
import { showReviewQueue } from "./src/tui/screens/review-queue.js";
import { showLiveQuery } from "./src/tui/screens/live-query.js";
import { showFixtureBrowser } from "./src/tui/screens/fixture-browser.js";
import { showEvalRunner } from "./src/tui/screens/eval-runner.js";
import type { AppState } from "./src/tui/types.js";

async function main() {
  intro("betabot affinate — dataset refinement tool");

  const state: AppState = {
    fixtures: loadFixtures(),
    runs: loadRuns(),
    latestRun: null,
    isDirty: false,
  };
  state.latestRun = state.runs[state.runs.length - 1] ?? null;

  while (true) {
    const failCount = state.latestRun
      ? state.latestRun.total - state.latestRun.pass
      : 0;
    const lastRate = state.latestRun
      ? `${((state.latestRun.pass / state.latestRun.total) * 100).toFixed(1)}% pass`
      : "no runs";

    const screen = await select({
      message: `${state.fixtures.length} fixtures  |  ${state.runs.length} runs  |  ${lastRate}`,
      options: [
        { value: "dashboard", label: "Dashboard         — trend + per-tool breakdown" },
        {
          value: "review-queue",
          label: `Review queue       — ${failCount} failure${failCount !== 1 ? "s" : ""} to review`,
        },
        { value: "live-query", label: "Live query         — test a question interactively" },
        { value: "fixture-browser", label: "Fixture browser    — search & edit fixtures" },
        { value: "eval-runner", label: "Run eval           — trigger a new evaluation" },
        { value: "quit", label: "Quit" },
      ],
    });

    if (isCancel(screen) || screen === "quit") break;

    switch (screen) {
      case "dashboard":
        await showDashboard(state);
        break;
      case "review-queue":
        await showReviewQueue(state);
        break;
      case "live-query":
        await showLiveQuery(state);
        break;
      case "fixture-browser":
        await showFixtureBrowser(state);
        break;
      case "eval-runner":
        await showEvalRunner(state);
        break;
    }

    // Reload after each screen in case fixtures or results changed
    state.fixtures = loadFixtures();
    state.runs = loadRuns();
    state.latestRun = state.runs[state.runs.length - 1] ?? null;
    state.isDirty = false;
  }

  outro("Au revoir!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

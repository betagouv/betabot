import { select, multiselect, text, confirm, note, log } from "@clack/prompts";
import type { AppState } from "../types.js";
import { classifyConfusion } from "../types.js";
import { saveFixtures } from "../data.js";
import { green, red, yellow, dim, bold, confusionColor } from "../ui/colors.js";

// All tool names — mirrored from orchestrator
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

const ALL_TOOL_NAMES = [
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
].map((t) => t.function.name);

function confusionLabel(type: string): string {
  switch (type) {
    case "no-tool-called": return red("No tool called");
    case "wrong-tool": return red("Wrong tool");
    case "partial-match": return yellow("Partial match");
    case "extra-tool": return yellow("Extra tool called");
    default: return green("Correct");
  }
}

export async function showReviewQueue(state: AppState): Promise<void> {
  const { latestRun } = state;

  if (!latestRun) {
    note("No eval runs found. Run: npm run eval", "Review Queue");
    return;
  }

  const failures = latestRun.cases.filter((c) => !c.pass);

  if (!failures.length) {
    note(green("No failures in the latest run!"), "Review Queue");
    return;
  }

  let idx = 0;

  while (idx >= 0 && idx < failures.length) {
    const cas = failures[idx]!;
    const fixture = state.fixtures.find((f) => f.id === cas.id);
    const actual = cas.tools.map((t) => t.name);
    const confusion = classifyConfusion(cas.expect_tools, actual);
    const colorFn = confusionColor(confusion);

    const lines: string[] = [
      bold(`[${idx + 1}/${failures.length}]  `) + dim(cas.id),
      "",
      bold("Question:  ") + cas.question,
      "",
      bold("Expected:  ") + (cas.expect_tools.length ? green(cas.expect_tools.join(", ")) : dim("(no tool)")),
      bold("Got:       ") + (actual.length ? colorFn(actual.join(", ")) : red("(none)")),
      "",
      bold("Type:      ") + confusionLabel(confusion),
      fixture?.annotation ? dim(`Note: ${fixture.annotation}`) : "",
      fixture?.review_status ? dim(`Status: ${fixture.review_status}`) : "",
    ].filter((l) => l !== undefined);

    note(lines.join("\n"), "Review Queue");

    const action = await select({
      message: "Action",
      options: [
        { value: "fix", label: "Fix expected tools" },
        { value: "model_error", label: "Mark as model error (skip — model needs to improve)" },
        { value: "ambiguous", label: "Mark as ambiguous" },
        { value: "annotate", label: "Add annotation note" },
        { value: "delete", label: "Delete this fixture" },
        { value: "next", label: `Next  (${idx + 1}/${failures.length})` },
        { value: "prev", label: "Previous" },
        { value: "back", label: "Back to main menu" },
      ],
    });

    if (!action || action === "back") break;

    if (action === "next") { idx++; continue; }
    if (action === "prev") { idx = Math.max(0, idx - 1); continue; }

    const fixtureIdx = state.fixtures.findIndex((f) => f.id === cas.id);

    if (action === "fix") {
      const selected = await multiselect({
        message: "Select the correct expected tools",
        options: ALL_TOOL_NAMES.map((name) => ({ value: name, label: name })),
        initialValues: actual.length ? actual : cas.expect_tools,
        required: false,
      });
      if (selected && !("Symbol" in Object && typeof selected === "symbol")) {
        const tools = selected as string[];
        if (fixtureIdx >= 0) {
          state.fixtures[fixtureIdx]!.expect_tools = tools;
          state.fixtures[fixtureIdx]!.reviewed_at = new Date().toISOString();
          state.fixtures[fixtureIdx]!.review_status = "ok";
        }
        saveFixtures(state.fixtures);
        log.success(`Updated expect_tools for ${cas.id}`);
      }
      idx++;

    } else if (action === "model_error" || action === "ambiguous") {
      if (fixtureIdx >= 0) {
        state.fixtures[fixtureIdx]!.review_status = action === "model_error" ? "model_error" : "ambiguous";
        state.fixtures[fixtureIdx]!.reviewed_at = new Date().toISOString();
        saveFixtures(state.fixtures);
        log.success(`Marked ${cas.id} as ${action}`);
      }
      idx++;

    } else if (action === "annotate") {
      const note_ = await text({
        message: "Annotation note",
        placeholder: "e.g. model misses follow-up tool when name is ambiguous",
        initialValue: fixture?.annotation ?? "",
      });
      if (note_ && typeof note_ === "string" && fixtureIdx >= 0) {
        state.fixtures[fixtureIdx]!.annotation = note_;
        saveFixtures(state.fixtures);
        log.success("Note saved");
      }

    } else if (action === "delete") {
      const ok = await confirm({ message: `Delete fixture "${cas.id}"?` });
      if (ok) {
        state.fixtures = state.fixtures.filter((f) => f.id !== cas.id);
        saveFixtures(state.fixtures);
        log.success(`Deleted ${cas.id}`);
        failures.splice(idx, 1);
        if (idx >= failures.length) idx = failures.length - 1;
      }
    }
  }
}

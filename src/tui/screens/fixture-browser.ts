import { text, select, confirm, log, note } from "@clack/prompts";
import type { AppState } from "../types.js";
import { saveFixtures, indexRunById } from "../data.js";
import { green, red, yellow, dim, bold, gray, passIcon } from "../ui/colors.js";

export async function showFixtureBrowser(state: AppState): Promise<void> {
  const runIndex = state.latestRun ? indexRunById(state.latestRun) : new Map();

  while (true) {
    const filter = await text({
      message: "Filter fixtures (text match, empty = show all)",
      placeholder: "member / startup / doc / …",
    });
    if (typeof filter === "symbol") return;

    const query = (filter ?? "").toLowerCase().trim();
    const filtered = query
      ? state.fixtures.filter(
          (f) =>
            f.question.toLowerCase().includes(query) ||
            f.id.toLowerCase().includes(query) ||
            f.expect_tools.some((t) => t.includes(query))
        )
      : state.fixtures;

    if (!filtered.length) {
      note("No fixtures match.", "Fixture Browser");
      continue;
    }

    const maxQ = 55;
    const maxT = 40;

    const lines: string[] = [
      bold(`${filtered.length} fixtures`) + (query ? dim(`  (filter: "${query}")`) : ""),
      "",
      dim("  " + "Status  Question".padEnd(maxQ + 2) + "  Expected tools"),
      dim("  " + "─".repeat(maxQ + maxT + 12)),
    ];

    for (const f of filtered.slice(0, 40)) {
      const cas = runIndex.get(f.id);
      const icon = cas ? passIcon(cas.pass) : yellow("?");
      const q = f.question.slice(0, maxQ).padEnd(maxQ);
      const tools = f.expect_tools.length
        ? f.expect_tools.join(", ").slice(0, maxT)
        : dim("(none)");
      const annotation = f.annotation ? dim(` [${f.annotation.slice(0, 20)}]`) : "";
      lines.push(`  ${icon}  ${q}  ${tools}${annotation}`);
    }

    if (filtered.length > 40) {
      lines.push(dim(`  … and ${filtered.length - 40} more`));
    }

    note(lines.join("\n"), "Fixture Browser");

    const action = await select({
      message: "Action",
      options: [
        { value: "edit", label: "Edit a fixture (enter its id)" },
        { value: "delete", label: "Delete a fixture (enter its id)" },
        { value: "filter", label: "New filter" },
        { value: "back", label: "Back to main menu" },
      ],
    });

    if (!action || action === "back") return;
    if (action === "filter") continue;

    const idInput = await text({
      message: action === "edit" ? "Fixture id to edit" : "Fixture id to delete",
      placeholder: "member-skill-python",
    });
    if (!idInput || typeof idInput === "symbol") continue;

    const fixtureIdx = state.fixtures.findIndex((f) => f.id === idInput);
    if (fixtureIdx < 0) {
      log.error(`Fixture "${idInput}" not found`);
      continue;
    }

    if (action === "delete") {
      const ok = await confirm({ message: `Delete "${idInput}"?` });
      if (ok) {
        state.fixtures.splice(fixtureIdx, 1);
        saveFixtures(state.fixtures);
        log.success(`Deleted ${idInput}`);
      }

    } else if (action === "edit") {
      const f = state.fixtures[fixtureIdx]!;
      const detail = [
        bold("id: ") + f.id,
        bold("question: ") + f.question,
        bold("expect_tools: ") + (f.expect_tools.join(", ") || dim("(none)")),
        f.annotation ? bold("note: ") + f.annotation : "",
        f.review_status ? bold("status: ") + f.review_status : "",
      ].filter(Boolean);
      note(detail.join("\n"), "Fixture detail");

      const editAction = await select({
        message: "Edit",
        options: [
          { value: "question", label: "Edit question" },
          { value: "annotation", label: "Edit annotation note" },
          { value: "back", label: "Cancel" },
        ],
      });

      if (editAction === "question") {
        const newQ = await text({ message: "New question", initialValue: f.question });
        if (newQ && typeof newQ === "string") {
          state.fixtures[fixtureIdx]!.question = newQ;
          saveFixtures(state.fixtures);
          log.success("Question updated");
        }
      } else if (editAction === "annotation") {
        const newNote = await text({ message: "Annotation", initialValue: f.annotation ?? "" });
        if (newNote !== undefined && typeof newNote === "string") {
          state.fixtures[fixtureIdx]!.annotation = newNote || undefined;
          saveFixtures(state.fixtures);
          log.success("Annotation saved");
        }
      }
    }
  }
}

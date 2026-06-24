export interface Fixture {
  id: string;
  question: string;
  expect_tools: string[];
  expect_first_tool?: string;
  expect_args?: Record<string, Record<string, unknown>>;
  annotation?: string;
  review_status?: "ok" | "model_error" | "ambiguous";
  reviewed_at?: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface CaseResult {
  id: string;
  question: string;
  expect_tools: string[];
  first_tool: string | null;
  tools: ToolCall[];
  pass: boolean;
  response_chars: number;
}

export interface RunResult {
  timestamp: string;
  git: string;
  model: string;
  pass: number;
  total: number;
  cases: CaseResult[];
}

export interface ToolStats {
  tool: string;
  total: number;
  pass: number;
  fail: number;
  passRate: number;
}

export interface AppState {
  fixtures: Fixture[];
  runs: RunResult[];
  latestRun: RunResult | null;
  isDirty: boolean;
}

export type ConfusionType =
  | "no-tool-called"
  | "wrong-tool"
  | "partial-match"
  | "extra-tool"
  | "correct";

export function classifyConfusion(
  expected: string[],
  actual: string[]
): ConfusionType {
  if (expected.length === 0 && actual.length === 0) return "correct";
  if (actual.length === 0) return "no-tool-called";
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const hasAll = expected.every((t) => actualSet.has(t));
  const hasSome = expected.some((t) => actualSet.has(t));
  if (hasAll && actual.length === expected.length) return "correct";
  if (hasAll && actual.length > expected.length) return "extra-tool";
  if (hasSome) return "partial-match";
  return "wrong-tool";
}

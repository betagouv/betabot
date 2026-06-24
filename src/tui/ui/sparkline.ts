const BLOCKS = " ▁▂▃▄▅▆▇█";

export function sparkline(values: number[], width = 30): string {
  if (!values.length) return " ".repeat(width);
  const slice = values.slice(-width);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const range = max - min || 1;
  return slice
    .map((v) => BLOCKS[Math.round(((v - min) / range) * (BLOCKS.length - 1))])
    .join("");
}

export function bar(ratio: number, width = 12): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(Math.max(0, filled)) + "░".repeat(Math.max(0, empty));
}

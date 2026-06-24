import chalk from "chalk";

export const green = (s: string) => chalk.green(s);
export const red = (s: string) => chalk.red(s);
export const yellow = (s: string) => chalk.yellow(s);
export const cyan = (s: string) => chalk.cyan(s);
export const dim = (s: string) => chalk.dim(s);
export const bold = (s: string) => chalk.bold(s);
export const gray = (s: string) => chalk.gray(s);

export function passIcon(pass: boolean): string {
  return pass ? green("✓") : red("✗");
}

export function confusionColor(type: string): (s: string) => string {
  switch (type) {
    case "no-tool-called": return red;
    case "wrong-tool": return red;
    case "partial-match": return yellow;
    case "extra-tool": return yellow;
    default: return green;
  }
}

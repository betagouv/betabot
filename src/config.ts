function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalInt(name: string, fallback: number): number {
  const val = process.env[name];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  openai: {
    baseUrl: optional("OPENAI_BASE_URL", "http://localhost:11434/v1"),
    apiKey: optional("OPENAI_API_KEY", "ollama"),
    model: optional("OPENAI_MODEL", "qwen2.5:14b"),
    embedModel: optional("OPENAI_EMBED_MODEL", "nomic-embed-text"),
    embedDims: optionalInt("EMBED_DIMS", 768),
  },
  dataDir: optional("DATA_DIR", "./data"),
  matrix: {
    homeserver: process.env["MATRIX_HOMESERVER"],
    user: process.env["MATRIX_USER"],
    accessToken: process.env["MATRIX_ACCESS_TOKEN"],
    password: process.env["MATRIX_PASSWORD"],
  },
} as const;

export function validateMatrixConfig(): void {
  if (!config.matrix.homeserver)
    throw new Error("Missing required environment variable: MATRIX_HOMESERVER");
  if (!config.matrix.user)
    throw new Error("Missing required environment variable: MATRIX_USER");
  if (!config.matrix.accessToken && !config.matrix.password)
    throw new Error(
      "Either MATRIX_ACCESS_TOKEN or MATRIX_PASSWORD must be set"
    );
}

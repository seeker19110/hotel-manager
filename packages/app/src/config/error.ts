// Shared by Node/edge configuration; contains no Node dependencies or environment values.
export class ConfigError extends Error {
  readonly issues: readonly { key: string; reason: string }[];
  constructor(issues: readonly { key: string; reason: string }[]) {
    super(`Invalid environment configuration: ${issues.map((i) => `${i.key} (${i.reason})`).join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

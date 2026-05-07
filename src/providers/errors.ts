export class MissingApiKeyError extends Error {
  readonly providerName: string;
  readonly envVar: string;

  constructor(providerName: string, envVar: string) {
    super(`${providerName} provider requires ${envVar} to be set`);
    this.name = "MissingApiKeyError";
    this.providerName = providerName;
    this.envVar = envVar;
  }
}

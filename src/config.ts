import "dotenv/config";

export interface DoltConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize: number;
}

export interface Config {
  dolt: DoltConfig;
}

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    dolt: {
      host: requireEnv("DOLT_HOST", "127.0.0.1"),
      port: parseInt(requireEnv("DOLT_PORT", "3306"), 10),
      user: requireEnv("DOLT_USER", "root"),
      password: requireEnv("DOLT_PASSWORD", ""),
      database: requireEnv("DOLT_DATABASE", "haol"),
      poolSize: parseInt(requireEnv("DOLT_POOL_SIZE", "5"), 10),
    },
  };
}

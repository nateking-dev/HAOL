import { loadConfig } from "./config.js";
import { createPool, healthCheck, destroy } from "./db/connection.js";

async function main() {
  const config = loadConfig();
  createPool(config.dolt);

  const healthy = await healthCheck();
  if (healthy) {
    console.log("HAOL connected to Dolt at %s:%d", config.dolt.host, config.dolt.port);
  } else {
    console.error("Failed to connect to Dolt at %s:%d", config.dolt.host, config.dolt.port);
    process.exit(1);
  }

  await destroy();
}

main();

#!/usr/bin/env node
import { run } from "../cli/index.js";

run(process.argv)
  .then((output) => {
    console.log(output);
  })
  .catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
  });

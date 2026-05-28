#!/usr/bin/env node
// Entry point. No subcommand → run the MCP server (stdio). Any subcommand →
// run the CLI (auth, sync, list, get, status).

import { runCli } from "./cli.js";
import { runServer } from "./server.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  runServer().catch((e) => {
    console.error("plaud-mcp:", (e as Error).message);
    process.exit(1);
  });
} else {
  runCli(args);
}

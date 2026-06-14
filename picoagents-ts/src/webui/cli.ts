#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { webui } from "./index.js";

interface CliArgs {
  dir: string;
  port: number;
  host: string;
  noOpen: boolean;
  staticDir?: string;
}

const args = parseArgs(process.argv.slice(2));
const entitiesDir = path.resolve(args.dir);

if (!existsSync(entitiesDir)) {
  console.error(`Directory does not exist: ${entitiesDir}`);
  process.exit(1);
}
if (!statSync(entitiesDir).isDirectory()) {
  console.error(`Path is not a directory: ${entitiesDir}`);
  process.exit(1);
}

await webui({
  entitiesDir,
  port: args.port,
  host: args.host,
  autoOpen: !args.noOpen,
  staticDir: args.staticDir
});

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    dir: ".",
    port: 8080,
    host: "127.0.0.1",
    noOpen: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") parsed.dir = argv[++index] ?? parsed.dir;
    else if (arg === "--port" || arg === "-p") parsed.port = Number(argv[++index] ?? parsed.port);
    else if (arg === "--host") parsed.host = argv[++index] ?? parsed.host;
    else if (arg === "--no-open") parsed.noOpen = true;
    else if (arg === "--static-dir") parsed.staticDir = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Launch PicoAgents WebUI

Usage:
  picoagentsui-ts [options]

Options:
  --dir <path>          Directory to scan for agents/orchestrators/workflows (default: .)
  --port, -p <number>  Port to run server on (default: 8080)
  --host <host>        Host to bind server to (default: 127.0.0.1)
  --static-dir <path>  Directory containing a built frontend
  --no-open            Do not automatically open a browser
  --help, -h           Show this help
`);
}

#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, SERVER_NAME, VERSION } from "./server.js";

if (!process.env.YNAB_API_TOKEN) {
  console.error(
    "ERROR: YNAB_API_TOKEN environment variable is required.\n" +
      "Create a personal access token at https://app.ynab.com/settings/developer."
  );
  process.exit(1);
}

serveStdio(createServer);
console.error(`${SERVER_NAME} ${VERSION} running via stdio`);

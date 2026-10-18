// Cross-platform test entry point.
//
// `node --test test/*.test.mjs` relies on the shell to expand `*`, which does
// not happen in Windows cmd/PowerShell. Expanding the list here keeps
// `npm test` identical on every OS. Only `*.test.mjs` is picked up, so helper
// scripts in this directory are not executed as tests.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(dir, name));

const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

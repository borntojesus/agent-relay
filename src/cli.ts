/**
 * Single entry for the packaged binary:
 *
 *   agent-relay [serve]                          run the server
 *   agent-relay owner|room|token|audit ...       admin CLI on RELAY_DB
 *   agent-relay worker run|install|uninstall|status|hook
 *   agent-relay --version | --help
 *
 * Modules load lazily: `worker hook` runs before every tool call of a task and
 * must not pay for the server and the MCP SDK. No top-level await (the binary
 * is bundled to CJS).
 */

const HELP = (version: string, workerHelp: string) => `agent-relay ${version}

usage:
  agent-relay [serve]                    run the relay (RELAY_DB, RELAY_HOST, RELAY_PORT, ...)
  agent-relay owner add <id> --name <name> [--telegram <user id>] [--tz <zone>]
  agent-relay owner list
  agent-relay room add <name> [--title <text>]
  agent-relay room list
  agent-relay token create <label> --owner <id> --grant <kind:name:r|w|rw> [--grant ...]
  agent-relay token grants <label> --grant ...
  agent-relay token list [--all]
  agent-relay token revoke <label>
  agent-relay audit [--limit N]
  agent-relay --version
  agent-relay --help

worker (runs Claude Code tasks for this machine):
${workerHelp}`;

const fail = (err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
};

const version = () => import("./mcp/server.ts").then((m) => m.VERSION);

const args = process.argv.slice(2);
const [first] = args;

if (first === "worker") {
  const sub = args[1];
  (sub === "hook" ? Promise.resolve("") : version())
    .then(async (v) => {
      const { runWorkerCli } = await import("./worker/cli.ts");
      return runWorkerCli(args.slice(1), v);
    })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // The hook fails closed: exit 2 blocks the tool call in Claude Code.
      if (sub === "hook") {
        console.error(
          `agent-relay hook: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
      fail(err);
    });
} else if (first === "--version" || first === "-v" || first === "version") {
  version().then((v) => console.log(v), fail);
} else if (first === "--help" || first === "-h" || first === "help") {
  Promise.all([version(), import("./worker/cli.ts")]).then(
    ([v, w]) => process.stdout.write(HELP(v, w.WORKER_HELP)),
    fail,
  );
} else if (first === undefined || first === "serve") {
  import("./serve.ts").then((m) => m.serve()).catch(fail);
} else if (["owner", "room", "team", "machine", "token", "audit"].includes(first)) {
  import("./admin.ts").then((m) => m.runAdmin(args), fail);
} else {
  Promise.all([version(), import("./worker/cli.ts")]).then(([v, w]) => {
    process.stderr.write(
      `unknown command: ${first}\n\n${HELP(v, w.WORKER_HELP)}`,
    );
    process.exitCode = 2;
  }, fail);
}

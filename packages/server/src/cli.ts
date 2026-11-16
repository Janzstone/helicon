import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRuntimePreference } from "@helicon/daemon";

function usage(): string {
  return [
    "helicon-server: local bridge between the Helicon UI and Muse MSP hosts.",
    "",
    "Options:",
    "  --port <n>        HTTP port (default 3127, 0 picks a free port)",
    "  --host <addr>     bind address (default 127.0.0.1)",
    "  --data-dir <dir>  sqlite directory, or :memory: (default ~/.helicon)",
    "  --static <dir>    serve a built frontend from this directory",
    "  --token <value>   require a token for non-loopback access",
    "  --allow-origin <o>  browser origin allowed to connect from another site (repeatable)",
    "  --frame-ancestor <o>  extra page origin allowed to frame the UI, beyond the editor extension (repeatable)",
    "  --distro <name>   WSL distro for muse on Windows (default: HELICON_WSL_DISTRO, else WSL's default)",
    "  --runtime <mode>  Windows only: native, wsl, or auto (default; native Muse once installed)",
    "  --muse <path>     explicit muse binary path",
  ].join("\n");
}

function flagValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1 || index + 1 >= argv.length) {
    return null;
  }
  return argv[index + 1] as string;
}

/** Every occurrence of a repeatable flag, as in `--allow-origin a --allow-origin b`. */
function flagValues(argv: string[], name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === name) {
      found.push(argv[index + 1] as string);
    }
  }
  return found;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage() + "\n");
    return;
  }
  const { HeliconServer } = await import("./server.js");
  const portRaw = flagValue(argv, "--port");
  const dataDir = flagValue(argv, "--data-dir") ?? join(homedir(), ".helicon");
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
  }
  const server = new HeliconServer({
    port: portRaw ? Number.parseInt(portRaw, 10) : 3127,
    host: flagValue(argv, "--host") ?? "127.0.0.1",
    dataDir,
    staticDir: flagValue(argv, "--static"),
    token: flagValue(argv, "--token"),
    allowOrigins: flagValues(argv, "--allow-origin"),
    frameAncestors: flagValues(argv, "--frame-ancestor"),
    distro: flagValue(argv, "--distro") ?? (process.env["HELICON_WSL_DISTRO"]?.trim() || undefined),
    runtime: parseRuntimePreference(flagValue(argv, "--runtime") ?? process.env["HELICON_MUSE_RUNTIME"]),
    musePath: flagValue(argv, "--muse") ?? undefined,
  });
  const bound = await server.listen();
  process.stdout.write(`helicon-server listening on http://${bound.host}:${bound.port}\n`);
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  process.stderr.write(`helicon-server failed: ${String(error)}\n`);
  process.exit(1);
});

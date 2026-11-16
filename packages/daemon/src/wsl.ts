import { execFile as execFileCallback } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { findNativeMuse, type MuseRuntime, type NativeMuse, type RuntimePreference } from "./native.js";

const execFileAsync = promisify(execFileCallback);

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export interface WslDistro {
  name: string;
  isDefault: boolean;
  state: string;
  version: number;
}

export interface ServePlan {
  command: string;
  args: string[];
  cwd: string;
  viaWsl: boolean;
  distro: string | null;
}

export function decodeCliOutput(raw: Buffer): string {
  let text: string;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    text = raw.toString("utf16le");
  } else {
    text = raw.toString("utf8");
  }
  return text.replace(/\0/g, "").replace(/\r\n/g, "\n");
}

export async function defaultExec(
  command: string,
  args: string[],
): Promise<ExecResult> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "buffer",
      windowsHide: true,
      timeout: 30000,
    });
    return { stdout: decodeCliOutput(stdout as Buffer), exitCode: 0 };
  } catch (error) {
    const code =
      typeof (error as { code?: unknown }).code === "number"
        ? ((error as { code: number }).code as number)
        : 1;
    const stdout = (error as { stdout?: unknown }).stdout;
    return {
      stdout: Buffer.isBuffer(stdout) ? decodeCliOutput(stdout) : "",
      exitCode: code,
    };
  }
}

export function parseWslList(output: string): WslDistro[] {
  const distros: WslDistro[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^name\s+state\s+version/i.test(trimmed)) {
      continue;
    }
    const match = trimmed.match(/^(\*?)\s*(\S+)\s+(\S+)\s+(\S+)/);
    if (!match) {
      continue;
    }
    distros.push({
      name: match[2] as string,
      isDefault: match[1] === "*",
      state: match[3] as string,
      version: Number.parseInt(match[4] as string, 10) || 0,
    });
  }
  return distros;
}

export function defaultDistro(distros: WslDistro[]): WslDistro | null {
  return distros.find((d) => d.isDefault) ?? distros[0] ?? null;
}

export function toWslPath(windowsPath: string): string {
  const match = windowsPath.match(/^([A-Za-z]):[\\/]+(.*)$/);
  if (!match) {
    throw new Error(`Cannot map to WSL: not an absolute Windows path: ${windowsPath}.`);
  }
  const drive = (match[1] as string).toLowerCase();
  const rest = (match[2] as string).replace(/[\\/]+/g, "/");
  return `/mnt/${drive}/${rest}`;
}

export function toWindowsPath(wslPath: string): string {
  const match = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!match) {
    throw new Error(`Cannot map to Windows: not a /mnt/<drive> path: ${wslPath}.`);
  }
  const drive = (match[1] as string).toUpperCase();
  const rest = (match[2] as string).replace(/\//g, "\\");
  return `${drive}:\\${rest}`;
}

export async function resolveMuseInDistro(
  exec: ExecFn,
  distro: string,
): Promise<string | null> {
  const result = await exec("wsl", [
    "-d",
    distro,
    "--",
    "sh",
    "-lc",
    "command -v muse",
  ]);
  if (result.exitCode !== 0) {
    return null;
  }
  const firstLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}

export function planServe(options: {
  platform?: string;
  distro?: string;
  musePath?: string | null;
  cwd: string;
  /** On Windows, `native` runs Windows Muse itself; anything else goes through WSL. */
  runtime?: MuseRuntime;
  /** Pass `muse serve --disable-sandbox`, lifting shell filesystem/network sandboxing for the host. */
  sandboxDisabled?: boolean;
  /** Pass `muse serve --disable-sandbox --trust-workspace`, the `muse --yolo` posture for the host. */
  yoloEnabled?: boolean;
}): ServePlan {
  const platform = options.platform ?? process.platform;
  const serveArgs = [
    "serve",
    ...(options.sandboxDisabled || options.yoloEnabled ? ["--disable-sandbox"] : []),
    ...(options.yoloEnabled ? ["--trust-workspace"] : []),
  ];
  if (platform === "win32" && options.runtime !== "native") {
    const distro = options.distro ?? "Ubuntu";
    if (options.musePath) {
      return {
        command: "wsl",
        args: ["-d", distro, "--", options.musePath, ...serveArgs],
        cwd: options.cwd,
        viaWsl: true,
        distro,
      };
    }
    return {
      command: "wsl",
      args: ["-d", distro, "--", "sh", "-lc", ["muse", ...serveArgs].join(" ")],
      cwd: options.cwd,
      viaWsl: true,
      distro,
    };
  }
  return {
    command: options.musePath ?? "muse",
    args: serveArgs,
    cwd: options.cwd,
    viaWsl: false,
    distro: null,
  };
}

/**
 * One program run with an exact argv where Muse lives: directly off Windows, and through `wsl -e` on
 * Windows, which skips the Linux shell so paths with spaces arrive as single arguments.
 */
export function planHostCommand(options: {
  platform?: string;
  distro?: string;
  program: string;
  args: string[];
  runtime?: MuseRuntime;
}): { command: string; args: string[] } {
  const platform = options.platform ?? process.platform;
  if (platform === "win32" && options.runtime !== "native") {
    return { command: "wsl", args: ["-d", options.distro ?? "Ubuntu", "-e", options.program, ...options.args] };
  }
  return { command: options.program, args: options.args };
}

/** A `muse` CLI call. Without a resolved path a login shell finds muse on PATH; `"$@"` passes the arguments through untouched. */
export function planMuseCli(options: {
  platform?: string;
  distro?: string;
  musePath?: string | null;
  args: string[];
  runtime?: MuseRuntime;
}): { command: string; args: string[] } {
  if (options.runtime === "native") {
    return { command: options.musePath ?? "muse", args: options.args };
  }
  const direct = options.musePath
    ? { program: options.musePath, args: options.args }
    : { program: "sh", args: ["-lc", 'exec muse "$@"', "muse", ...options.args] };
  return planHostCommand({ platform: options.platform, distro: options.distro, runtime: options.runtime, ...direct });
}

export interface EnvironmentProbe {
  platform: string;
  /** Where Muse runs. On Windows, `native` when Windows Muse is installed (unless WSL is asked for), else `wsl`. */
  runtime: MuseRuntime;
  /** Native Windows Muse, when installed, whichever runtime was picked. */
  native: NativeMuse | null;
  wslAvailable: boolean;
  distros: WslDistro[];
  defaultDistro: string | null;
  musePath: string | null;
}

/** Folders the Muse installer and package managers put `muse` in, checked when it is not on PATH. */
export function findPosixMuse(home: string, exists: (path: string) => boolean = existsSync): string | null {
  const candidates = [`${home}/.local/bin/muse`, "/opt/homebrew/bin/muse", "/usr/local/bin/muse"];
  return candidates.find((path) => exists(path)) ?? null;
}

/**
 * Whether the default Muse login on macOS, Linux or native Windows has stored credentials.
 * `muse login` and `muse auth set` record each provider in `$XDG_CONFIG_HOME/muse/auth.json` (the
 * secret itself may sit in the keychain). Windows Muse uses the same file under the user profile,
 * `%USERPROFILE%\.config\muse\auth.json`, and honours XDG_CONFIG_HOME too (checked with Muse
 * 1.4.10). A META_API_KEY in Helicon's environment also counts, since Muse inherits it and needs no
 * file then. Otherwise no file or no providers means a first prompt would fail. Null when the file
 * is there but unreadable, since then Helicon cannot tell.
 */
export function museSignedIn(
  home: string,
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): boolean | null {
  if (env["META_API_KEY"]?.trim()) {
    return true;
  }
  const config = env["XDG_CONFIG_HOME"] || `${home}/.config`;
  let text: string;
  try {
    text = read(`${config}/muse/auth.json`);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
  try {
    const providers = (JSON.parse(text) as { providers?: unknown }).providers;
    return typeof providers === "object" && providers !== null && Object.keys(providers).length > 0;
  } catch {
    return null;
  }
}

export async function probeEnvironment(
  exec: ExecFn = defaultExec,
  platform: string = process.platform,
  options: {
    preference?: RuntimePreference;
    findNative?: () => NativeMuse | null;
    home?: string;
    exists?: (path: string) => boolean;
    /** The WSL distro to use (`--distro` / `HELICON_WSL_DISTRO`); WSL's own default when unset. */
    distro?: string;
  } = {},
): Promise<EnvironmentProbe> {
  if (platform !== "win32") {
    const found = await exec("sh", ["-lc", "command -v muse"]);
    const onPath =
      found.exitCode === 0
        ? (found.stdout.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)
        : null;
    // A Muse install made after Helicon started is not on its PATH yet, so look where installers put it.
    const musePath = onPath ?? findPosixMuse(options.home ?? homedir(), options.exists ?? existsSync);
    return { platform, runtime: "posix", native: null, wslAvailable: false, distros: [], defaultDistro: null, musePath };
  }
  const preference = options.preference ?? "auto";
  const native = (options.findNative ?? (() => findNativeMuse()))();
  // Native Muse needs no WSL at all, so WSL is not even started to look.
  if (native && preference !== "wsl") {
    return { platform, runtime: "native", native, wslAvailable: false, distros: [], defaultDistro: null, musePath: native.binary };
  }
  if (preference === "native") {
    return { platform, runtime: "native", native: null, wslAvailable: false, distros: [], defaultDistro: null, musePath: null };
  }
  const listed = await exec("wsl", ["-l", "-v"]);
  if (listed.exitCode !== 0) {
    return { platform, runtime: "wsl", native, wslAvailable: false, distros: [], defaultDistro: null, musePath: null };
  }
  const distros = parseWslList(listed.stdout);
  // A pinned distro wins over WSL's default, and Muse is looked up in the same distro it later runs in.
  const pinned = options.distro?.trim();
  const def = pinned
    ? (distros.find((d) => d.name.toLowerCase() === pinned.toLowerCase()) ?? { name: pinned, isDefault: false, state: "", version: 0 })
    : defaultDistro(distros);
  const musePath = def ? await resolveMuseInDistro(exec, def.name) : null;
  return {
    platform,
    runtime: "wsl",
    native,
    wslAvailable: true,
    distros,
    defaultDistro: def ? def.name : null,
    musePath,
  };
}

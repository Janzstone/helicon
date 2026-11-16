import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCliOutput,
  defaultDistro,
  parseWslList,
  planHostCommand,
  planMuseCli,
  planServe,
  museSignedIn,
  probeEnvironment,
  resolveMuseInDistro,
  toWindowsPath,
  toWslPath,
  type ExecFn,
} from "../src/wsl.js";

const SAMPLE_WSL_LIST = `  NAME                   STATE           VERSION
* Ubuntu                 Running         2
  docker-desktop         Stopped         2
`;

describe("wsl paths", () => {
  it("translates Windows and WSL paths both ways", () => {
    assert.equal(toWslPath("D:\\work\\helicon"), "/mnt/d/work/helicon");
    assert.equal(toWslPath("C:/proj"), "/mnt/c/proj");
    assert.equal(toWindowsPath("/mnt/d/work/helicon"), "D:\\work\\helicon");
    assert.throws(() => toWslPath("relative/path"), /absolute Windows path/);
    assert.throws(() => toWindowsPath("/home/harjot"), /\/mnt\/<drive>/);
  });

  it("decodes UTF-16 WSL output", () => {
    const utf16 = Buffer.from(SAMPLE_WSL_LIST, "utf16le");
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]);
    const distros = parseWslList(decodeCliOutput(withBom));
    assert.equal(distros.length, 2);
    assert.equal(distros[0]?.name, "Ubuntu");
    assert.equal(distros[0]?.isDefault, true);
    assert.equal(defaultDistro(distros)?.name, "Ubuntu");
  });
});

describe("host commands", () => {
  it("runs a program through wsl -e on Windows so arguments are not re-parsed by a shell", () => {
    assert.deepEqual(planHostCommand({ platform: "win32", distro: "Debian", program: "cat", args: ["/mnt/d/my project/a.md"] }), {
      command: "wsl",
      args: ["-d", "Debian", "-e", "cat", "/mnt/d/my project/a.md"],
    });
    assert.deepEqual(planHostCommand({ platform: "linux", program: "cat", args: ["a b"] }), { command: "cat", args: ["a b"] });
  });

  it("calls muse by its resolved path, or through a login shell that forwards the arguments", () => {
    assert.deepEqual(planMuseCli({ platform: "linux", musePath: "/usr/bin/muse", args: ["skills", "list"] }), {
      command: "/usr/bin/muse",
      args: ["skills", "list"],
    });
    assert.deepEqual(planMuseCli({ platform: "win32", args: ["skills", "list", "--workspace", "/mnt/d/a b"] }), {
      command: "wsl",
      args: ["-d", "Ubuntu", "-e", "sh", "-lc", 'exec muse "$@"', "muse", "skills", "list", "--workspace", "/mnt/d/a b"],
    });
  });
});

describe("serve planning", () => {
  it("routes Windows through WSL with a resolved binary when known", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/harjot/.local/bin/muse",
      cwd: "D:\\work\\helicon",
    });
    assert.deepEqual(direct, {
      command: "wsl",
      args: ["-d", "Ubuntu", "--", "/home/harjot/.local/bin/muse", "serve"],
      cwd: "D:\\work\\helicon",
      viaWsl: true,
      distro: "Ubuntu",
    });
    const loginShell = planServe({ platform: "win32", cwd: "D:\\work\\helicon" });
    assert.deepEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve"]);
  });

  it("runs natively off Windows", () => {
    const native = planServe({ platform: "linux", cwd: "/work/proj" });
    assert.deepEqual(native, {
      command: "muse",
      args: ["serve"],
      cwd: "/work/proj",
      viaWsl: false,
      distro: null,
    });
  });

  it("adds --disable-sandbox when asked, on every route", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/harjot/.local/bin/muse",
      cwd: "D:\\work\\helicon",
      sandboxDisabled: true,
    });
    assert.deepEqual(direct.args, ["-d", "Ubuntu", "--", "/home/harjot/.local/bin/muse", "serve", "--disable-sandbox"]);
    const loginShell = planServe({ platform: "win32", cwd: "D:\\work\\helicon", sandboxDisabled: true });
    assert.deepEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve --disable-sandbox"]);
    const native = planServe({ platform: "linux", cwd: "/work/proj", sandboxDisabled: true });
    assert.deepEqual(native.args, ["serve", "--disable-sandbox"]);
  });

  it("adds the YOLO flags when asked, on every route", () => {
    const direct = planServe({
      platform: "win32",
      distro: "Ubuntu",
      musePath: "/home/harjot/.local/bin/muse",
      cwd: "D:\\work\\helicon",
      yoloEnabled: true,
    });
    assert.deepEqual(direct.args, [
      "-d",
      "Ubuntu",
      "--",
      "/home/harjot/.local/bin/muse",
      "serve",
      "--disable-sandbox",
      "--trust-workspace",
    ]);
    const loginShell = planServe({ platform: "win32", cwd: "D:\\work\\helicon", yoloEnabled: true });
    assert.deepEqual(loginShell.args, ["-d", "Ubuntu", "--", "sh", "-lc", "muse serve --disable-sandbox --trust-workspace"]);
    const native = planServe({ platform: "linux", cwd: "/work/proj", yoloEnabled: true });
    assert.deepEqual(native.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
  });

  it("does not duplicate --disable-sandbox when both the sandbox switch and YOLO are on", () => {
    const native = planServe({ platform: "linux", cwd: "/work/proj", sandboxDisabled: true, yoloEnabled: true });
    assert.deepEqual(native.args, ["serve", "--disable-sandbox", "--trust-workspace"]);
  });
});

describe("environment probe", () => {
  it("finds muse inside the default distro", async () => {
    const exec: ExecFn = async (command, args) => {
      if (command === "wsl" && args[0] === "-l") {
        return { stdout: SAMPLE_WSL_LIST, exitCode: 0 };
      }
      assert.deepEqual(args.slice(0, 3), ["-d", "Ubuntu", "--"]);
      return { stdout: "/home/harjot/.local/bin/muse\n", exitCode: 0 };
    };
    const probe = await probeEnvironment(exec, "win32");
    assert.equal(probe.wslAvailable, true);
    assert.equal(probe.defaultDistro, "Ubuntu");
    assert.equal(probe.musePath, "/home/harjot/.local/bin/muse");
    assert.equal(await resolveMuseInDistro(exec, "Ubuntu"), "/home/harjot/.local/bin/muse");
  });

  it("finds a posix Muse installed after startup when it is not on PATH", async () => {
    const exec: ExecFn = async () => ({ stdout: "", exitCode: 1 });
    const installed = new Set(["/Users/new/.local/bin/muse"]);
    const probe = await probeEnvironment(exec, "darwin", { home: "/Users/new", exists: (path) => installed.has(path) });
    assert.equal(probe.musePath, "/Users/new/.local/bin/muse");
    const none = await probeEnvironment(exec, "darwin", { home: "/Users/new", exists: () => false });
    assert.equal(none.musePath, null);
  });

  it("prefers the Muse on PATH over the install folders", async () => {
    const exec: ExecFn = async () => ({ stdout: "/opt/homebrew/bin/muse\n", exitCode: 0 });
    const probe = await probeEnvironment(exec, "darwin", { home: "/Users/new", exists: () => true });
    assert.equal(probe.musePath, "/opt/homebrew/bin/muse");
  });

  it("looks for Muse in a pinned distro instead of WSL's default", async () => {
    const list = `  NAME            STATE           VERSION
* Ubuntu          Running         2
  Ubuntu-24.04    Running         2
`;
    const asked: string[] = [];
    const exec: ExecFn = async (command, args) => {
      if (command === "wsl" && args[0] === "-l") {
        return { stdout: list, exitCode: 0 };
      }
      asked.push(args[1] as string);
      return args[1] === "Ubuntu-24.04" ? { stdout: "/usr/local/bin/muse\n", exitCode: 0 } : { stdout: "", exitCode: 1 };
    };
    const probe = await probeEnvironment(exec, "win32", { preference: "wsl", distro: "ubuntu-24.04" });
    assert.equal(probe.defaultDistro, "Ubuntu-24.04");
    assert.equal(probe.musePath, "/usr/local/bin/muse");
    assert.deepEqual(asked, ["Ubuntu-24.04"]);
  });

  it("reports missing WSL cleanly", async () => {
    const exec: ExecFn = async () => ({ stdout: "", exitCode: 1 });
    const probe = await probeEnvironment(exec, "win32");
    assert.equal(probe.wslAvailable, false);
    assert.equal(probe.musePath, null);
  });
});

describe("museSignedIn", () => {
  const missing = (): string => {
    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
  };

  it("is false when Muse has never been signed in", () => {
    assert.equal(museSignedIn("/Users/new", {}, missing), false);
  });

  it("is true when auth.json lists a provider, reading from ~/.config by default", () => {
    const read = (path: string): string => {
      assert.equal(path, "/Users/me/.config/muse/auth.json");
      return JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: "oauth", storage: "keychain" } } });
    };
    assert.equal(museSignedIn("/Users/me", {}, read), true);
  });

  it("follows XDG_CONFIG_HOME", () => {
    const read = (path: string): string => {
      assert.equal(path, "/xdg/muse/auth.json");
      return JSON.stringify({ providers: { meta: {} } });
    };
    assert.equal(museSignedIn("/Users/me", { XDG_CONFIG_HOME: "/xdg" }, read), true);
  });

  it("is true with a META_API_KEY in the environment and no auth.json", () => {
    assert.equal(museSignedIn("/Users/new", { META_API_KEY: "k" }, missing), true);
    assert.equal(museSignedIn("/Users/new", { META_API_KEY: "  " }, missing), false, "a blank key does not count");
  });

  it("is false after logout leaves no providers", () => {
    assert.equal(museSignedIn("/Users/me", {}, () => JSON.stringify({ schema_version: 1, providers: {} })), false);
  });

  it("is unknown when the file cannot be read or parsed", () => {
    const denied = (): string => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    assert.equal(museSignedIn("/Users/me", {}, denied), null);
    assert.equal(museSignedIn("/Users/me", {}, () => "{not json"), null);
  });
});

// Swaps this checkout's server and web build into an installed T3 Code, replacing only
// `server.asar`. Run `--restore` to put the official one back. Installing a release overwrites
// the swap, so run this again after each app update.
//
//   node scripts/install-auto-handoff.ts [--resources <dir>] [--no-build] [--force] [--restore]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const isWindows = NodePath.sep === "\\";
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

function defaultResourcesDir(): string {
  if (isWindows) {
    return NodePath.join(process.env.LOCALAPPDATA ?? "", "Programs", "t3code", "resources");
  }
  const macResources = "/Applications/T3 Code (Beta).app/Contents/Resources";
  if (NodeFS.existsSync(macResources)) return macResources;
  throw new Error("Pass --resources <dir> with the installed app's resources directory.");
}

function run(
  command: string,
  commandArgs: ReadonlyArray<string>,
  cwd = repoRoot,
  env: Record<string, string> = {},
): string {
  return NodeChildProcess.execFileSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    // Only the .cmd shims need a shell; it would split the spaces in other arguments.
    shell: isWindows && (command === "npx" || command.endsWith(".cmd")),
  }).trim();
}

// Release builds bake the T3 Connect sign-in config into the client. A local build has none, so the
// sign-in never loads and remote environments stay disconnected. These values are public in the
// shipped client, so read them back from it (tracing tokens are deliberately not copied).
function officialClientEnv(stageDist: string, appVersion: string): Record<string, string> {
  const env: Record<string, string> = { APP_VERSION: appVersion };
  const assetsDir = NodePath.join(stageDist, "client", "assets");
  const file = NodeFS.readdirSync(assetsDir).find((name) => /^publicConfig-.*\.js$/.test(name));
  const source = file ? NodeFS.readFileSync(NodePath.join(assetsDir, file), "utf8") : "";
  const pick = (text: string, pattern: RegExp) => pattern.exec(text)?.[1];
  const key = pick(source, /clerkPublishableKey:\w+\(`(pk_(?:live|test)_[\w=-]+)`\)/);
  const template = pick(source, /clerkJwtTemplate:\w+\(`([^`]+)`\)/);
  const relay = pick(source, /relayUrl:\w+\(`(https:\/\/[^`]+)`\)/);
  const serverChunk = NodeFS.readdirSync(stageDist).find((name) => /^binCli-.*\.mjs$/.test(name));
  const cliClientId = serverChunk
    ? pick(
        NodeFS.readFileSync(NodePath.join(stageDist, serverChunk), "utf8"),
        /buildTimeClerkCliOAuthClientId = readBuildTimeValue\("([^"]+)"\)/,
      )
    : undefined;
  if (key && template && relay) {
    env.VITE_CLERK_PUBLISHABLE_KEY = env.T3CODE_CLERK_PUBLISHABLE_KEY = key;
    env.VITE_CLERK_JWT_TEMPLATE = env.T3CODE_CLERK_JWT_TEMPLATE = template;
    env.VITE_T3CODE_RELAY_URL = env.T3CODE_RELAY_URL = relay;
    if (cliClientId) {
      env.VITE_CLERK_CLI_OAUTH_CLIENT_ID = env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID = cliClientId;
    }
  } else {
    console.warn(
      "Could not read the T3 Connect config from the installed client; sign-in may fail.",
    );
  }
  return env;
}

const asar = (...asarArgs: ReadonlyArray<string>) =>
  run("npx", ["--yes", "@electron/asar", ...asarArgs]);

function assertAppClosed(): void {
  if (!isWindows) return;
  const running = run("tasklist", ["/FI", "IMAGENAME eq T3 Code (Beta).exe", "/NH"]);
  if (running.includes("T3 Code (Beta).exe")) {
    throw new Error("Close T3 Code first: it holds server.asar open.");
  }
}

const resourcesDir = NodePath.resolve(option("--resources") ?? defaultResourcesDir());
const serverAsar = NodePath.join(resourcesDir, "server.asar");
const unpackedDir = `${serverAsar}.unpacked`;
const backupAsar = NodePath.join(resourcesDir, "server.asar.official");
const backupUnpacked = `${backupAsar}.unpacked`;

if (!NodeFS.existsSync(serverAsar)) throw new Error(`No server.asar in ${resourcesDir}.`);
assertAppClosed();

if (flag("--restore")) {
  if (!NodeFS.existsSync(backupAsar)) throw new Error("No official server.asar backup to restore.");
  NodeFS.copyFileSync(backupAsar, serverAsar);
  if (NodeFS.existsSync(backupUnpacked))
    NodeFS.cpSync(backupUnpacked, unpackedDir, { recursive: true });
  console.log("Restored the official server.asar.");
  process.exit(0);
}

const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-auto-handoff-"));
try {
  // Refuse a patch built from older code than the app: its server would not know the
  // migrations the app already applied to the user's database.
  // `extract-file` writes into its working directory, so keep it out of the checkout.
  run(
    "npx",
    [
      "--yes",
      "@electron/asar",
      "extract-file",
      NodePath.join(resourcesDir, "app.asar"),
      "package.json",
    ],
    work,
  );
  const installed = JSON.parse(
    NodeFS.readFileSync(NodePath.join(work, "package.json"), "utf8"),
  ) as {
    readonly version: string;
    readonly t3codeCommitHash?: string;
  };
  const installedCommit = installed.t3codeCommitHash;
  if (installedCommit && !flag("--force")) {
    try {
      run("git", ["merge-base", "--is-ancestor", installedCommit, "HEAD"]);
    } catch {
      throw new Error(
        `Installed app ${installed.version} (${installedCommit}) is not contained in this checkout. ` +
          "Rebase the patch onto that release first, or pass --force.",
      );
    }
  }

  // Always start from the official asar: a previous run already replaced the client in server.asar.
  const stage = NodePath.join(work, "stage");
  asar("extract", NodeFS.existsSync(backupAsar) ? backupAsar : serverAsar, stage);
  const stageDist = NodePath.join(stage, "apps", "server", "dist");

  if (!flag("--no-build")) {
    const vp = NodePath.join(repoRoot, "node_modules", ".bin", isWindows ? "vp.cmd" : "vp");
    const env = officialClientEnv(stageDist, installed.version);
    run(vp, ["run", "build:bundle"], NodePath.join(repoRoot, "apps", "server"), env);
    run(vp, ["build"], NodePath.join(repoRoot, "apps", "web"), env);
  }

  const serverDist = NodePath.join(repoRoot, "apps", "server", "dist");
  const webDist = NodePath.join(repoRoot, "apps", "web", "dist");

  // Copy only chunks reachable from the entry points: the build keeps stale hashed chunks.
  const isChunk = (name: string) => /-[A-Za-z0-9_-]{8}\.mjs$/.test(name);
  const reachable = new Set<string>();
  const queue = NodeFS.readdirSync(serverDist).filter((n) => n.endsWith(".mjs") && !isChunk(n));
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    if (reachable.has(name)) continue;
    reachable.add(name);
    const source = NodeFS.readFileSync(NodePath.join(serverDist, name), "utf8");
    for (const match of source.matchAll(/["']\.\/([A-Za-z0-9_.-]+\.mjs)["']/g)) {
      if (NodeFS.existsSync(NodePath.join(serverDist, match[1]!))) queue.push(match[1]!);
    }
  }
  for (const name of NodeFS.readdirSync(stageDist)) {
    NodeFS.rmSync(NodePath.join(stageDist, name), { recursive: true, force: true });
  }
  for (const name of reachable) {
    NodeFS.copyFileSync(NodePath.join(serverDist, name), NodePath.join(stageDist, name));
  }
  NodeFS.cpSync(webDist, NodePath.join(stageDist, "client"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map") && NodePath.basename(source) !== ".vite",
  });

  const built = NodePath.join(work, "server.asar");
  asar("pack", stage, built, "--unpack", "*.{node,dll,exe}");

  if (!NodeFS.existsSync(backupAsar)) {
    NodeFS.copyFileSync(serverAsar, backupAsar);
    if (NodeFS.existsSync(unpackedDir))
      NodeFS.cpSync(unpackedDir, backupUnpacked, { recursive: true });
  }
  NodeFS.copyFileSync(built, serverAsar);
  NodeFS.cpSync(`${built}.unpacked`, unpackedDir, { recursive: true });
  console.log(`Installed the patched server into ${resourcesDir} (app ${installed.version}).`);
  console.log("Undo with: node scripts/install-auto-handoff.ts --restore");
} finally {
  NodeFS.rmSync(work, { recursive: true, force: true });
}

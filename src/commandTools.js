import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024;
const SUPPORTED_COMMAND_MODES = new Set(["auto", "confirm-all", "confirm-risky"]);
const DISALLOWED_SHELL_PATTERN = /[|&;<>()`$\n\r]/;
const DISALLOWED_PYTHON_ARGS = new Set(["-c", "-m", "-i", "-"]);
const DISALLOWED_NODE_ARGS = new Set(["-e", "--eval", "-p", "--print", "-i", "--interactive"]);

function clampTimeout(timeoutMs) {
  const parsed = Number.parseInt(timeoutMs, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }

  return Math.min(parsed, MAX_COMMAND_TIMEOUT_MS);
}

function stripOuterQuotes(token) {
  return token.replace(/^['"]|['"]$/g, "");
}

function tokenizeCommandString(command) {
  const input = String(command ?? "").trim();
  if (!input) {
    throw new Error("Command cannot be empty.");
  }

  if (DISALLOWED_SHELL_PATTERN.test(input)) {
    throw new Error("Shell metacharacters are not allowed in run_command.");
  }

  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const tokens = matches.map(stripOuterQuotes).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Command cannot be empty.");
  }

  return tokens;
}

function normalizeCommandInput(command) {
  if (Array.isArray(command)) {
    if (command.length === 0) {
      throw new Error("Command array cannot be empty.");
    }

    const tokens = command.map((token) => {
      if (typeof token !== "string") {
        throw new Error("Command array entries must be strings.");
      }
      if (DISALLOWED_SHELL_PATTERN.test(token)) {
        throw new Error("Shell metacharacters are not allowed in run_command.");
      }
      return token;
    });

    return tokens;
  }

  if (typeof command === "string") {
    return tokenizeCommandString(command);
  }

  throw new Error("Command must be a string or an array of strings.");
}

function validateAllowedCommand(tokens) {
  const [command, ...args] = tokens;

  switch (command) {
    case "python":
    case "python3":
      if (args.some((arg) => DISALLOWED_PYTHON_ARGS.has(arg))) {
        throw new Error(`Disallowed ${command} argument in run_command.`);
      }
      return;
    case "node":
      if (args.some((arg) => DISALLOWED_NODE_ARGS.has(arg))) {
        throw new Error("Disallowed node argument in run_command.");
      }
      return;
    case "pytest":
      return;
    case "npm":
      if (args[0] !== "test") {
        throw new Error("Only 'npm test' is allowed in run_command.");
      }
      if (args.length > 1 && args[1] !== "--") {
        throw new Error("Only 'npm test' or 'npm test -- ...' is allowed in run_command.");
      }
      return;
    case "ls":
      return;
    case "pwd":
      if (args.length > 0) {
        throw new Error("pwd does not accept arguments in run_command.");
      }
      return;
    default:
      throw new Error(`Command is not allowed in run_command: ${command}`);
  }
}

function appendBuffer(store, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  if (store.bytes >= MAX_OUTPUT_BYTES) {
    store.truncated = true;
    return;
  }

  const remaining = MAX_OUTPUT_BYTES - store.bytes;
  if (buffer.length <= remaining) {
    store.parts.push(buffer);
    store.bytes += buffer.length;
    return;
  }

  store.parts.push(buffer.subarray(0, remaining));
  store.bytes += remaining;
  store.truncated = true;
}

function stringifyCaptured(store) {
  return Buffer.concat(store.parts).toString("utf8");
}

function getCommandMode() {
  const configured = String(process.env.LOCAL_AGENT_COMMAND_MODE ?? "auto").trim().toLowerCase();
  if (SUPPORTED_COMMAND_MODES.has(configured)) {
    return configured;
  }

  return "auto";
}

function assertCommandModeAllowsExecution() {
  const mode = getCommandMode();
  if (mode === "auto") {
    return mode;
  }

  throw new Error(
    `run_command is configured for '${mode}', but interactive confirmation is not implemented yet. ` +
    "Set LOCAL_AGENT_COMMAND_MODE=auto to enable execution.",
  );
}

function formatCommand(tokens) {
  return tokens.map((token) => {
    if (/[\s"]/u.test(token)) {
      return JSON.stringify(token);
    }
    return token;
  }).join(" ");
}

async function runSpawnedCommand(tokens, cwd, timeoutMs) {
  return await new Promise((resolve, reject) => {
    const stdout = { parts: [], bytes: 0, truncated: false };
    const stderr = { parts: [], bytes: 0, truncated: false };
    let timedOut = false;
    let finished = false;

    const child = spawn(tokens[0], tokens.slice(1), {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 500).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => appendBuffer(stdout, chunk));
    child.stderr.on("data", (chunk) => appendBuffer(stderr, chunk));

    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(killTimer);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(killTimer);
      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal ?? null,
        timedOut,
        stdout: stringifyCaptured(stdout),
        stderr: stringifyCaptured(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}

function normalizeWorkspaceCwd(workspace, cwd) {
  const absoluteCwd = workspace.resolvePath(cwd ?? ".");
  return {
    absoluteCwd,
    relativeCwd: workspace.toRelativePath(absoluteCwd),
  };
}

export async function executeRunCommand(workspace, args = {}) {
  assertCommandModeAllowsExecution();

  const tokens = normalizeCommandInput(args.command);
  validateAllowedCommand(tokens);

  const timeoutMs = clampTimeout(args.timeoutMs);
  const { absoluteCwd, relativeCwd } = normalizeWorkspaceCwd(workspace, args.cwd);
  const commandText = formatCommand(tokens);
  const result = await runSpawnedCommand(tokens, absoluteCwd, timeoutMs);

  return {
    command: commandText,
    cwd: relativeCwd,
    absoluteCwd,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    commandOk: result.exitCode === 0 && !result.timedOut,
  };
}

async function ensureGitRepository(workspace, cwd = ".") {
  const { absoluteCwd, relativeCwd } = normalizeWorkspaceCwd(workspace, cwd);
  const probe = await runSpawnedCommand(["git", "rev-parse", "--show-toplevel"], absoluteCwd, DEFAULT_COMMAND_TIMEOUT_MS);

  if (probe.exitCode !== 0 || probe.timedOut) {
    throw new Error(`Not a git repository: ${relativeCwd}`);
  }

  const gitRoot = probe.stdout.trim();
  if (!gitRoot) {
    throw new Error(`Unable to resolve git root for: ${relativeCwd}`);
  }

  return {
    absoluteCwd,
    relativeCwd,
    gitRoot,
  };
}

function parseGitStatusPorcelain(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).filter(Boolean);
  const branchLine = lines[0]?.startsWith("## ") ? lines[0].slice(3) : "";
  const fileLines = lines[0]?.startsWith("## ") ? lines.slice(1) : lines;
  const files = fileLines.map((line) => ({
    status: line.slice(0, 2),
    path: line.slice(3).trim(),
  }));

  return {
    branch: branchLine,
    isClean: files.length === 0,
    files,
  };
}

export async function executeGitStatus(workspace, args = {}) {
  const repo = await ensureGitRepository(workspace, args.cwd ?? ".");
  const result = await runSpawnedCommand(
    ["git", "status", "--short", "--branch"],
    repo.absoluteCwd,
    DEFAULT_COMMAND_TIMEOUT_MS,
  );

  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(result.stderr.trim() || "git status failed.");
  }

  const parsed = parseGitStatusPorcelain(result.stdout);
  return {
    command: "git status --short --branch",
    cwd: repo.relativeCwd,
    gitRoot: repo.gitRoot,
    branch: parsed.branch,
    isClean: parsed.isClean,
    files: parsed.files,
    raw: result.stdout,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  };
}

export async function executeGitDiff(workspace, args = {}) {
  const repo = await ensureGitRepository(workspace, args.cwd ?? ".");
  const gitArgs = ["git", "diff", "--no-ext-diff"];

  if (args.staged) {
    gitArgs.push("--staged");
  }

  let relativePath = null;
  if (args.path) {
    const absolutePath = workspace.resolvePath(args.path);
    relativePath = workspace.toRelativePath(absolutePath);
    gitArgs.push("--", relativePath);
  }

  const result = await runSpawnedCommand(gitArgs, repo.absoluteCwd, DEFAULT_COMMAND_TIMEOUT_MS);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(result.stderr.trim() || "git diff failed.");
  }

  return {
    command: formatCommand(gitArgs),
    cwd: repo.relativeCwd,
    gitRoot: repo.gitRoot,
    staged: Boolean(args.staged),
    path: relativePath,
    diff: result.stdout,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    truncated: result.stdoutTruncated || result.stderrTruncated,
  };
}

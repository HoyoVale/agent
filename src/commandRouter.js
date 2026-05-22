export const COMMAND_NAMES = [
  "help",
  "api",
  "mount",
  "pwd",
  "ls",
  "info",
  "read",
  "cat",
  "find",
  "search",
  "models",
  "model",
  "tools",
  "trace",
  "status",
  "history",
  "multiline",
  "send",
  "cancel",
  "last",
  "copy",
  "clear",
  "reset",
  "exit",
  "quit",
];

function tokenize(input) {
  const matches = input.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function parseCommand(input) {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const tokens = tokenize(normalized);

  if (tokens.length === 0) {
    return null;
  }

  const [name, ...args] = tokens;
  return {
    name: name.toLowerCase(),
    args,
    raw: input,
  };
}

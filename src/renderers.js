import path from "node:path";

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
  blue: "\u001b[34m",
  gray: "\u001b[90m",
};

function colorize(text, color, enabled) {
  if (!enabled) {
    return text;
  }

  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function emphasize(text, enabled) {
  if (!enabled) {
    return text;
  }

  return `${ANSI.bold}${text}${ANSI.reset}`;
}

function dim(text, enabled) {
  if (!enabled) {
    return text;
  }

  return `${ANSI.dim}${text}${ANSI.reset}`;
}

export function renderPanel(title, body, options = {}) {
  const color = options.color ?? "cyan";
  const useColor = options.useColor ?? false;
  const compact = options.compact ?? false;
  const dimBody = options.dimBody ?? false;
  const iconMap = {
    welcome: "o",
    analysis: "-",
    assistant: ">",
    tool: "~",
    error: "!",
    info: "i",
  };
  const label = `${iconMap[title] ?? "-"} ${title}`;
  const header = compact
    ? emphasize(colorize(label, color, useColor), useColor)
    : `${emphasize(colorize(label, color, useColor), useColor)} ${colorize("─".repeat(Math.max(8, 26 - label.length)), "gray", useColor)}`;
  const panelBody = dimBody ? dim(body, useColor) : body;
  return `${header}\n${panelBody}`;
}

export function renderHelp() {
  return [
    "Workspace commands:",
    "  /api [url|index]     Show or set the Ollama/OpenAI-compatible base URL",
    "  /mount [dir]         Mount a project directory, or show the current mount",
    "  /pwd                 Show the mounted directory",
    "  /ls [path]           List files inside the mounted directory",
    "  /info <path>         Show file or directory metadata",
    "  /read <path> [a] [b] Read a text file, optionally by line range",
    "  /find <text> [path]  Search text inside the mounted directory",
    "",
    "Model commands:",
    "  /models              List Ollama models",
    "  /model [name|index]  Show or set the active Ollama model",
    "  /tools               List model-callable workspace tools",
    "  /trace [open|close]  Show the last tool trace summary or details",
    "  /status              Show endpoint, model, workspace, and session info",
    "",
    "Session commands:",
    "  /history [count]     Show recent conversation turns",
    "  /multiline           Start multiline input mode",
    "  /send                Send the current multiline buffer",
    "  /cancel              Cancel multiline input mode",
    "  /last                Re-render the last assistant response",
    "  /copy                Copy the last assistant response",
    "  /clear               Clear chat history",
    "  /reset               Alias for /clear",
    "  /help                Show this help",
    "  /exit                Quit the CLI",
    "",
    "Tips:",
    "  Any non-command input is sent to the active Ollama model.",
    "  The model can read, search, inspect, and now edit workspace files through tools.",
    "  Use Tab after '/' to complete command names.",
    "  Ctrl+L clears the screen and redraws the prompt.",
    "  /api and /model with no arguments open a quick picker in interactive mode.",
    "  In a picker, use Up/Down and Enter, or type a value manually.",
  ].join("\n");
}

export function renderPrompt(rootPath, activeModel, isMultiline = false, selectionMode = null) {
  if (selectionMode) {
    return `select[${selectionMode}]> `;
  }

  const workspaceLabel = rootPath ? path.basename(rootPath) : "unmounted";
  const modelLabel = activeModel || "no-model";
  const modeLabel = isMultiline ? "|multi" : "";

  return `agent[${workspaceLabel}|${modelLabel}${modeLabel}]> `;
}

export function renderRuntimeStatusLine(status, useColor = false) {
  const mode = status?.mode ?? "idle";
  const activity = status?.activity ?? "idle";
  const lastTool = status?.lastTool ?? "none";
  const line = `status  mode=${mode}  activity=${activity}  last=${lastTool}`;
  return useColor ? colorize(line, "gray", true) : line;
}

export function renderWelcome(baseUrl, rootPath, activeModel) {
  return [
    "Local Coding Agent MVP",
    "Interactive workspace agent for local projects.",
    `Ollama endpoint: ${baseUrl}`,
    `Workspace: ${rootPath ?? "(not mounted)"}`,
    `Active model: ${activeModel || "(not set)"}`,
    'Type "/help" for commands.',
  ].join("\n");
}

export function renderMountedWorkspace(rootPath) {
  if (!rootPath) {
    return "Workspace: (not mounted)";
  }

  return `Workspace: ${rootPath}`;
}

export function renderList(entries, userPath) {
  if (entries.length === 0) {
    return `${userPath}: empty`;
  }

  const body = entries.map((entry) => {
    const marker = entry.type === "dir" ? "[dir] " : "[file]";
    return `  ${marker} ${entry.name}`;
  });

  return [`${userPath}:`, ...body].join("\n");
}

export function renderInfo(info) {
  return [
    `Path: ${info.absolutePath}`,
    `Type: ${info.isDirectory ? "directory" : info.isFile ? "file" : "other"}`,
    `Size: ${info.size} bytes`,
    `Modified: ${info.modifiedAt}`,
  ].join("\n");
}

export function renderReadResult(result) {
  const header = [
    `Path: ${result.absolutePath}`,
    `Lines: ${result.startLine}-${result.endLine}`,
    `File size: ${result.size} bytes`,
  ];

  if (result.truncated) {
    header.push("Note: output truncated to the first 262144 bytes for stability.");
  }

  return `${header.join("\n")}\n\n${result.content}`;
}

export function renderFindResults(result) {
  const header = [
    `Query: ${result.query}`,
    `Search root: ${result.root}`,
    `Files scanned: ${result.filesScanned}`,
    `Matches: ${result.results.length}`,
  ];

  if (result.truncated) {
    header.push(`Note: stopped after ${result.maxResults} matches for stability.`);
  }

  if (result.results.length === 0) {
    return `${header.join("\n")}\n\nNo matches found.`;
  }

  const body = result.results.map((match) => {
    return `${match.path}:${match.line}:${match.column} | ${match.preview}`;
  });

  return `${header.join("\n")}\n\n${body.join("\n")}`;
}

export function renderModels(models, activeModel) {
  if (models.length === 0) {
    return "No Ollama models found.";
  }

  const lines = models.map((model, index) => {
    const marker = model.name === activeModel ? "*" : " ";
    return `${marker} ${String(index + 1).padStart(2, " ")}. ${model.name}`;
  });

  return ["Available models:", ...lines].join("\n");
}

export function renderStatus({ baseUrl, activeModel, rootPath, messageCount, runtimeStatus }) {
  return [
    `Ollama endpoint: ${baseUrl}`,
    `Active model: ${activeModel || "(not set)"}`,
    `Workspace: ${rootPath || "(not mounted)"}`,
    `Session turns: ${messageCount / 2}`,
    `Mode: ${runtimeStatus?.mode ?? "idle"}`,
    `Activity: ${runtimeStatus?.activity ?? "idle"}`,
    `Last tool: ${runtimeStatus?.lastTool ?? "none"}`,
  ].join("\n");
}

export function renderRecentBaseUrls(currentBaseUrl, recentBaseUrls) {
  const lines = [`Current endpoint: ${currentBaseUrl}`];

  if (recentBaseUrls.length === 0) {
    lines.push("No recent endpoints saved yet.");
    return lines.join("\n");
  }

  lines.push("", "Recent endpoints:");
  recentBaseUrls.forEach((url, index) => {
    const marker = url === currentBaseUrl ? "*" : " ";
    lines.push(`${marker} ${index + 1}. ${url}`);
  });
  lines.push("", 'Use "/api <index>" or "/api <url>" to switch.');

  return lines.join("\n");
}

export function renderApiPicker(currentBaseUrl, recentBaseUrls, selectedIndex = 0) {
  const lines = [
    "Endpoint picker:",
    `Current: ${currentBaseUrl}`,
  ];

  if (recentBaseUrls.length > 0) {
    lines.push("", "Recent endpoints:");
    recentBaseUrls.forEach((url, index) => {
      const marker = url === currentBaseUrl ? "*" : " ";
      const selectedMarker = index === selectedIndex ? ">" : " ";
      lines.push(`${selectedMarker}${marker} ${index + 1}. ${url}`);
    });
  } else {
    lines.push("", "No recent endpoints saved yet.");
  }

  lines.push("", "Use Up/Down + Enter, type an index, paste a new URL, or use /cancel.");
  return lines.join("\n");
}

export function renderTools(toolNames) {
  return ["Model-callable tools:", ...toolNames.map((name) => `  ${name}`)].join("\n");
}

export function renderApiUpdated(baseUrl) {
  return `Ollama endpoint updated: ${baseUrl}`;
}

export function renderModelUpdated(modelName) {
  return `Active model set to: ${modelName}`;
}

export function renderRecentModels(currentModel, recentModels, availableModels = []) {
  const lines = [`Current model: ${currentModel || "(not set)"}`];

  if (availableModels.length > 0) {
    lines.push("", "Available models from current endpoint:");
    availableModels.forEach((model, index) => {
      const marker = model.name === currentModel ? "*" : " ";
      lines.push(`${marker} ${index + 1}. ${model.name}`);
    });
    lines.push("", 'Use "/model <index>" to pick from the available list.');
  }

  if (recentModels.length > 0) {
    lines.push("", "Recent models:");
    recentModels.forEach((model, index) => {
      const marker = model === currentModel ? "*" : " ";
      lines.push(`${marker} ${index + 1}. ${model}`);
    });
    lines.push("", 'If no live model list is loaded, "/model <index>" uses this recent list.');
  } else if (availableModels.length === 0) {
    lines.push("No recent models saved yet.");
  }

  return lines.join("\n");
}

export function renderModelPicker(currentModel, recentModels, availableModels = [], selectedLabel = null) {
  const lines = [
    "Model picker:",
    `Current: ${currentModel || "(not set)"}`,
  ];

  if (availableModels.length > 0) {
    lines.push("", "Available models:");
    availableModels.forEach((model, index) => {
      const marker = model.name === currentModel ? "*" : " ";
      const label = `${index + 1}. ${model.name}`;
      const selectedMarker = label === selectedLabel ? ">" : " ";
      lines.push(`${selectedMarker}${marker} ${label}`);
    });
  }

  if (recentModels.length > 0) {
    lines.push("", "Recent models:");
    recentModels.forEach((model, index) => {
      const marker = model === currentModel ? "*" : " ";
      const label = `r${index + 1}. ${model}`;
      const selectedMarker = label === selectedLabel ? ">" : " ";
      lines.push(`${selectedMarker}${marker} ${label}`);
    });
  }

  lines.push("", "Use Up/Down + Enter, type an index/name, or use /cancel.");
  return lines.join("\n");
}

export function renderAssistantResponse(content, useColor = false) {
  return renderMarkdown(stripThinkingArtifacts(content) || "(empty response)", useColor);
}

export function renderAssistantDraft(content) {
  const text = String(content ?? "");
  return text.trim() ? text : "...";
}

function buildWrappedPreview(content, { maxLines = 2, lineWidth = 72 } = {}) {
  const text = String(content ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return ["..."];
  }

  const words = normalized.split(" ");
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= lineWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
    }
    current = word;

    if (lines.length >= maxLines) {
      break;
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  const truncated = normalized.length > lines.join(" ").length;
  if (truncated && lines.length > 0) {
    const lastIndex = Math.min(lines.length, maxLines) - 1;
    const line = lines[lastIndex];
    lines[lastIndex] = line.length >= lineWidth
      ? `${line.slice(0, Math.max(0, lineWidth - 3))}...`
      : `${line}...`;
  }

  return lines.slice(0, maxLines);
}

export function renderAnalysisDraft(content) {
  return buildWrappedPreview(content, {
    maxLines: 2,
    lineWidth: 72,
  }).join("\n");
}

export function renderAnalysisFinal(content, maxLength = 1200) {
  const normalized = String(content ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty analysis)";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return [
    `${normalized.slice(0, maxLength - 3)}...`,
    "",
    'Analysis truncated in the live output. Use "/trace open" for the full captured text.',
  ].join("\n");
}

function normalizeToolArgs(argsValue) {
  if (!argsValue) {
    return {};
  }

  if (typeof argsValue === "string") {
    try {
      return JSON.parse(argsValue);
    } catch {
      return {};
    }
  }

  return argsValue;
}

function summarizeToolText(value, maxLength = 48) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

export function renderToolCommand(toolName, argsValue) {
  const args = normalizeToolArgs(argsValue);

  switch (toolName) {
    case "list_dir":
      return `$ ls ${args.path ?? "."}`;
    case "read_file": {
      const suffix = args.startLine
        ? `:${args.startLine}${args.endLine ? `-${args.endLine}` : ""}`
        : "";
      return `$ read ${args.path ?? "."}${suffix}`;
    }
    case "find_in_files":
      return `$ find "${summarizeToolText(args.query, 32)}" ${args.path ?? "."}`;
    case "inspect_path":
      return `$ info ${args.path ?? "."}`;
    case "write_file":
      return `$ write ${args.path ?? "."} <${Buffer.byteLength(String(args.content ?? ""), "utf8")} bytes>`;
    case "replace_in_file":
      return `$ replace ${args.path ?? "."} --find "${summarizeToolText(args.find, 24)}" --replace "${summarizeToolText(args.replace, 24)}"`;
    default:
      return `$ ${toolName}`;
  }
}

export function renderToolCall(toolName, argsValue) {
  return renderToolCommand(toolName, argsValue);
}

export function renderFileWriteResult(toolName, result) {
  const lines = [];
  const action = toolName === "replace_in_file"
    ? "Updated file"
    : result.created
      ? "Created file"
      : "Updated file";

  lines.push(action);
  lines.push(`Path: ${result.path}`);
  lines.push(`Bytes written: ${result.bytesWritten}`);

  if (typeof result.lineCount === "number") {
    lines.push(`Line count: ${result.lineCount}`);
  }

  if (typeof result.replacements === "number") {
    lines.push(`Replacements: ${result.replacements}`);
  }

  if (result.backupPath) {
    lines.push(`Backup: ${result.backupPath}`);
  }

  return lines.join("\n");
}

export function renderToolFailure(toolName, errorMessage) {
  return `Tool ${toolName} failed: ${errorMessage}`;
}

function stripPrompt(command) {
  return String(command ?? "").replace(/^\$\s*/, "");
}

export function renderToolStatusLine(entry) {
  if (!entry) {
    return "";
  }

  const command = stripPrompt(entry.command);
  if (entry.status === "cancelled") {
    return `can ${command}`;
  }

  if (entry.status === "error") {
    return `err ${command}`;
  }

  if (entry.status === "success") {
    return `ok  ${command}`;
  }

  if (entry.status === "requested") {
    return `... ${command}`;
  }

  return `$ ${command}`;
}

export function renderTraceSummary(entries, analysisSections = []) {
  if ((!entries || entries.length === 0) && analysisSections.length === 0) {
    return "No tool trace available.";
  }

  const safeEntries = entries ?? [];
  const successCount = safeEntries.filter((entry) => entry.status === "success").length;
  const failureCount = safeEntries.filter((entry) => entry.status === "error").length;
  const cancelledCount = safeEntries.filter((entry) => entry.status === "cancelled").length;
  const files = safeEntries
    .map((entry) => entry.result?.path)
    .filter(Boolean);

  const lines = safeEntries.slice(-5).map((entry) => renderToolStatusLine(entry));

  if (files.length > 0) {
    lines.push(`files: ${files.join(", ")}`);
  }

  if (analysisSections.length > 0) {
    lines.push(`analysis: ${analysisSections.length} segment${analysisSections.length === 1 ? "" : "s"} captured`);
  }

  lines.push(
    `${safeEntries.length} tool call${safeEntries.length === 1 ? "" : "s"} complete (` +
    `${successCount} ok, ${failureCount} failed, ${cancelledCount} cancelled)`,
  );
  lines.push('Use "/trace open" to inspect the last trace.');
  return lines.join("\n");
}

export function renderTraceActivity(entries) {
  if (!entries || entries.length === 0) {
    return "idle";
  }

  const runningEntry = entries.find((entry) => entry.status === "running");
  const visibleEntries = entries.slice(-3);

  if (!runningEntry) {
    return visibleEntries.map((entry) => renderToolStatusLine(entry)).join("\n");
  }

  return visibleEntries.map((entry) => {
    if (entry.status === "running") {
      return renderToolStatusLine(entry);
    }

    return `  ${renderToolStatusLine(entry)}`;
  }).join("\n");
}

export function renderTraceExpanded(entries, analysisSections = []) {
  if ((!entries || entries.length === 0) && analysisSections.length === 0) {
    return "No tool trace available.";
  }

  const lines = ["Trace details:"];

  if (analysisSections.length > 0) {
    lines.push("", "Analysis", "--------");
    analysisSections.forEach((section, index) => {
      lines.push(`  ${index + 1}. ${section}`);
    });
  }

  if (!entries || entries.length === 0) {
    return lines.join("\n");
  }

  lines.push("", "Tool trace", "----------");

  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.command}`);

    if (entry.status === "running") {
      lines.push("   status: running");
      return;
    }

    if (entry.status === "requested") {
      lines.push("   status: requested");
      return;
    }

    if (entry.status === "cancelled") {
      lines.push("   status: cancelled");
      return;
    }

    if (entry.status === "error") {
      lines.push(`   status: error`);
      lines.push(`   error: ${entry.error}`);
      return;
    }

    lines.push("   status: success");
    if (entry.result?.path) {
      lines.push(`   path: ${entry.result.path}`);
    }
    if (typeof entry.result?.bytesWritten === "number") {
      lines.push(`   bytes: ${entry.result.bytesWritten}`);
    }
    if (typeof entry.result?.lineCount === "number") {
      lines.push(`   lines: ${entry.result.lineCount}`);
    }
    if (typeof entry.result?.replacements === "number") {
      lines.push(`   replacements: ${entry.result.replacements}`);
    }
    if (entry.result?.backupPath) {
      lines.push(`   backup: ${entry.result.backupPath}`);
    }
  });

  return lines.join("\n");
}

export function renderErrorMessage(message) {
  return message;
}

export function renderInfoMessage(message) {
  return message;
}

export function renderSpinnerDone(label) {
  return `${label} done`;
}

export function renderMultilineIntro() {
  return [
    "Multiline mode enabled.",
    "Type your message across multiple lines.",
    'Use "/send" to submit or "/cancel" to discard.',
  ].join("\n");
}

export function renderMultilineCancelled() {
  return "Multiline buffer discarded.";
}

export function renderMultilineBufferEmpty() {
  return "Multiline buffer is empty.";
}

export function renderLastResponseMissing() {
  return "No assistant response available yet.";
}

export function renderHistory(messages, requestedCount) {
  if (messages.length === 0) {
    return "Conversation history is empty.";
  }

  const turnPairs = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }

    const assistant = messages[index + 1];
    turnPairs.push({
      user: message.content,
      assistant: assistant?.role === "assistant" ? assistant.content : "(no assistant response stored)",
    });
  }

  const count = Math.max(1, requestedCount ?? 5);
  const slice = turnPairs.slice(-count);
  const lines = ["Recent conversation:"];

  slice.forEach((turn, index) => {
    lines.push(`${index + 1}. user: ${summarizeText(turn.user)}`);
    lines.push(`   assistant: ${summarizeText(turn.assistant)}`);
  });

  return lines.join("\n");
}

function summarizeText(value, maxLength = 120) {
  const singleLine = String(value ?? "").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
}

function stripThinkingArtifacts(content) {
  const text = String(content ?? "");
  if (!text) {
    return "";
  }

  return text
    .replace(/<think>\s*[\s\S]*?\s*<\/think>/gi, "")
    .replace(/^\s*<\/?think>\s*$/gim, "")
    .trim();
}

function renderMarkdown(content, useColor) {
  const lines = String(content).replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let inCodeBlock = false;
  let codeBlockLanguage = "";
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      const fence = line.trim().slice(3).trim();
      inCodeBlock = !inCodeBlock;
      codeBlockLanguage = inCodeBlock ? fence.toLowerCase() : "";
      if (inCodeBlock) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (output.length > 0 && output[output.length - 1] !== "") {
          output.push("");
        }
        output.push(...renderCodeBlock(codeLines, codeBlockLanguage, useColor));
        output.push("");
      } else {
        output.push("");
      }
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const [tableLines, nextIndex] = collectTable(lines, index);
      if (output.length > 0 && output[output.length - 1] !== "") {
        output.push("");
      }
      output.push(...renderTable(tableLines, useColor));
      output.push("");
      index = nextIndex;
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const text = line.replace(/^#{1,6}\s+/, "");
      const headingText = `${"#".repeat(level)} ${text}`;
      output.push(useColor ? emphasize(headingText, true) : headingText);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      output.push(renderInlineMarkdown(line.replace(/^\s*[-*]\s+/, "• "), useColor));
      index += 1;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      output.push(renderInlineMarkdown(line.trim(), useColor));
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      output.push(renderInlineMarkdown(line.replace(/^\s*>\s?/, "│ "), useColor));
      index += 1;
      continue;
    }

    output.push(renderInlineMarkdown(line, useColor));
    index += 1;
  }

  return output.filter((line, idx, arr) => !(line === "" && arr[idx - 1] === "")).join("\n");
}

function renderInlineMarkdown(text, useColor = false) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, (_, value) => useColor ? emphasize(value, true) : value.toUpperCase())
    .replace(/\*(.+?)\*/g, (_, value) => `_${value}_`)
    .replace(/`([^`]+)`/g, (_, value) => {
      const wrapped = `\`${value}\``;
      return useColor ? colorize(emphasize(wrapped, true), "cyan", true) : wrapped;
    });
}

function highlightCodeLine(line, language, useColor) {
  let output = line;

  if (!useColor) {
    return output;
  }

  output = output.replace(/(".*?"|'.*?'|`.*?`)/g, "\u001b[33m$1\u001b[0m");
  output = output.replace(/\b(\d+)\b/g, "\u001b[36m$1\u001b[0m");

  if (["js", "javascript", "ts", "typescript", "json"].includes(language)) {
    output = output.replace(/\b(import|from|const|let|var|function|return|async|await|if|else|for|while|class|new|export|default|true|false|null)\b/g, "\u001b[35m$1\u001b[0m");
  }

  if (["sh", "bash", "shell"].includes(language)) {
    output = output.replace(/\b(if|then|fi|for|do|done|case|esac|export)\b/g, "\u001b[35m$1\u001b[0m");
  }

  output = output.replace(/(\/\/.*$|#.*$)/g, "\u001b[2m$1\u001b[0m");
  return output;
}

function renderCodeBlock(lines, language, useColor) {
  const visibleLines = lines.length > 0 ? lines : [""];
  const highlighted = visibleLines.map((line) => highlightCodeLine(line, language, useColor));
  const fenceStart = `\`\`\`${language || ""}`;
  const fenceEnd = "```";

  if (!useColor) {
    return [fenceStart, ...visibleLines, fenceEnd];
  }

  return [
    colorize(fenceStart, "gray", true),
    ...highlighted,
    colorize(fenceEnd, "gray", true),
  ];
}

function isTableStart(lines, index) {
  if (index + 1 >= lines.length) {
    return false;
  }

  return lines[index].includes("|") && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[index + 1]);
}

function collectTable(lines, startIndex) {
  const tableLines = [lines[startIndex], lines[startIndex + 1]];
  let index = startIndex + 2;

  while (index < lines.length && lines[index].includes("|")) {
    tableLines.push(lines[index]);
    index += 1;
  }

  return [tableLines, index];
}

function renderTable(tableLines, useColor) {
  const rows = tableLines
    .filter((line, index) => !(index === 1 && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line)))
    .map((line) => splitTableRow(line, useColor));

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const next = [...row];
    while (next.length < columnCount) {
      next.push("");
    }
    return next;
  });
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...normalized.map((row) => row[columnIndex].length)),
  );

  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  const body = normalized.map((row, index) => {
    const line = `| ${row.map((cell, cellIndex) => cell.padEnd(widths[cellIndex])).join(" | ")} |`;
    if (index === 0) {
      return [border, line, border];
    }
    return [line];
  }).flat();

  return [...body, border];
}

function splitTableRow(line, useColor) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => renderInlineMarkdown(cell.trim(), useColor));
}

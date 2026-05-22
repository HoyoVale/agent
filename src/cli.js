import readline from "node:readline";
import process from "node:process";
import { runAgentTurn } from "./agentLoop.js";
import { copyToClipboard } from "./clipboard.js";
import { COMMAND_NAMES, parseCommand } from "./commandRouter.js";
import { getInitialModel, OllamaClient } from "./ollamaClient.js";
import {
  renderAnalysisDraft,
  renderAnalysisFinal,
  renderApiUpdated,
  renderAssistantDraft,
  renderAssistantResponse,
  renderErrorMessage,
  renderFindResults,
  renderHelp,
  renderHistory,
  renderInfo,
  renderInfoMessage,
  renderList,
  renderLastResponseMissing,
  renderModelUpdated,
  renderModels,
  renderMountedWorkspace,
  renderMultilineBufferEmpty,
  renderMultilineCancelled,
  renderMultilineIntro,
  renderPanel,
  renderApiPicker,
  renderModelPicker,
  renderPrompt,
  renderReadResult,
  renderRecentBaseUrls,
  renderRecentModels,
  renderRuntimeStatusLine,
  renderSpinnerDone,
  renderStatus,
  renderToolCommand,
  renderTraceActivity,
  renderTraceExpanded,
  renderTraceSummary,
  renderTools,
  renderWelcome,
} from "./renderers.js";
import { loadSessionState, rememberBaseUrl, rememberModel } from "./sessionStore.js";
import { Spinner } from "./spinner.js";
import { getToolNames } from "./toolRegistry.js";
import { Workspace } from "./workspace.js";

const LIVE_REDRAW_INTERVAL_MS = 80;

function isAbortError(error) {
  return error?.code === "EUSERABORT" || error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function printWelcome(state) {
  console.log(renderPanel(
    "welcome",
    renderWelcome(state.ollama.baseUrl, state.workspace.rootPath, state.activeModel),
    { color: "cyan", useColor: state.useColor },
  ));
  console.log("");
}

function renderOutputPanel(kind, body, state, panelOptions = {}) {
  const colorMap = {
    welcome: "cyan",
    analysis: "yellow",
    assistant: "green",
    tool: "magenta",
    error: "red",
    info: "blue",
  };

  return renderPanel(kind, body, {
    color: colorMap[kind] ?? "cyan",
    useColor: state.useColor,
    ...panelOptions,
  });
}

function createCompleter() {
  return (line) => {
    if (!line.startsWith("/")) {
      return [[], line];
    }

    const matches = COMMAND_NAMES
      .map((commandName) => `/${commandName}`)
      .filter((commandName) => commandName.startsWith(line));

    return [matches.length > 0 ? matches : COMMAND_NAMES.map((commandName) => `/${commandName}`), line];
  };
}

function getPrompt(state) {
  const prompt = renderPrompt(
    state.workspace.rootPath,
    state.activeModel,
    state.multilineMode,
    state.selectionMode?.kind ?? null,
  );
  if (state.selectionMode) {
    return prompt;
  }

  return `${renderRuntimeStatusLine(state.runtimeStatus, state.useColor)}\n${prompt}`;
}

function clearScreen(rl, state) {
  process.stdout.write("\u001bc");
  printWelcome(state);
  rl.setPrompt(getPrompt(state));
  if (state.multilineMode && state.multilineBuffer.length > 0) {
    console.log(renderOutputPanel("info", renderMultilineIntro(), state));
    console.log(state.multilineBuffer.join("\n"));
  }
  if (state.selectionMode) {
    printSelectionMode(state);
  }
  drawLiveRegions(state);
  rl.prompt(true);
}

function clearLiveRegions(state) {
  cancelScheduledLiveRegionDraw(state);
  if (!state.useColor || state.liveRegionLines < 1) {
    state.liveRegionLines = 0;
    state.liveRegionRendered = "";
    return;
  }

  const recalculatedLines = state.liveRegionRendered
    ? countRenderedTerminalLines(state.liveRegionRendered, state)
    : 0;
  const linesToClear = Math.max(state.liveRegionLines, recalculatedLines);

  process.stdout.write(`\u001b[${linesToClear}A\r\u001b[J`);
  state.liveRegionLines = 0;
  state.liveRegionRendered = "";
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function getTerminalColumns(state) {
  const columns = state.outputColumns ?? process.stdout.columns ?? 80;
  return Math.max(20, columns);
}

function getCharacterWidth(char) {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) {
    return 0;
  }

  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  ) {
    return 2;
  }

  return 1;
}

function getDisplayWidth(text) {
  let width = 0;
  for (const char of String(text ?? "")) {
    width += getCharacterWidth(char);
  }
  return width;
}

function countRenderedTerminalLines(rendered, state) {
  const columns = getTerminalColumns(state);
  const lines = String(rendered ?? "").split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.reduce((count, line) => {
    const width = getDisplayWidth(stripAnsi(line));
    return count + Math.max(1, Math.ceil(width / columns));
  }, 0);
}

function resetAnalysisStream(state) {
  state.analysisStream.active = false;
  state.analysisStream.buffer = "";
}

function getAnalysisDisplayMode() {
  const preferred = String(process.env.LOCAL_AGENT_ANALYSIS ?? "").trim().toLowerCase();
  if (["off", "final", "live"].includes(preferred)) {
    return preferred;
  }

  const legacy = String(process.env.LOCAL_AGENT_SHOW_ANALYSIS ?? "").trim().toLowerCase();
  if (legacy === "0" || legacy === "false" || legacy === "off") {
    return "off";
  }
  if (legacy === "live") {
    return "live";
  }

  return "live";
}

function persistAnalysisBuffer(state) {
  const text = state.analysisStream.buffer.trim();
  if (!text) {
    resetAnalysisStream(state);
    return;
  }

  state.trace.activeAnalysisSections.push(text);
  if (state.analysisDisplayMode === "final") {
    clearLiveRegions(state);
    console.log(renderOutputPanel(
      "analysis",
      renderAnalysisFinal(text),
      state,
      { compact: true, dimBody: true },
    ));
  }
  resetAnalysisStream(state);
}

function resetAssistantStream(state) {
  state.assistantStream.active = false;
  state.assistantStream.buffer = "";
  state.assistantStream.sawChunks = false;
}

function createToolRunId(state) {
  const next = state.nextToolRunId;
  state.nextToolRunId += 1;
  return `tool-${next}`;
}

function markPendingToolEntriesCancelled(state) {
  state.trace.activeEntries = state.trace.activeEntries.map((entry) => {
    if (entry.status === "requested" || entry.status === "running") {
      return {
        ...entry,
        status: "cancelled",
        completedAt: new Date().toISOString(),
        error: entry.error ?? "Interrupted by user.",
      };
    }

    return entry;
  });
}

function drawLiveRegions(state) {
  cancelScheduledLiveRegionDraw(state);
  renderLiveRegionsNow(state);
}

function scheduleLiveRegions(state) {
  if (!state.useColor) {
    return;
  }

  const now = Date.now();
  const elapsed = now - (state.liveRegionLastDrawAt ?? 0);
  if (elapsed >= LIVE_REDRAW_INTERVAL_MS) {
    drawLiveRegions(state);
    return;
  }

  if (state.liveRegionTimer) {
    return;
  }

  state.liveRegionTimer = setTimeout(() => {
    state.liveRegionTimer = null;
    renderLiveRegionsNow(state);
  }, LIVE_REDRAW_INTERVAL_MS - elapsed);
}

function cancelScheduledLiveRegionDraw(state) {
  if (!state?.liveRegionTimer) {
    return;
  }

  clearTimeout(state.liveRegionTimer);
  state.liveRegionTimer = null;
}

function renderLiveRegionsNow(state) {
  if (!state.useColor) {
    return;
  }

  const panels = [];

  if (state.analysisStream.active) {
    panels.push(renderOutputPanel(
      "analysis",
      renderAnalysisDraft(state.analysisStream.buffer),
      state,
      { compact: true, dimBody: true },
    ));
  }

  if (state.trace.activeEntries.length > 0) {
    panels.push(renderOutputPanel(
      "tool",
      renderTraceActivity(state.trace.activeEntries),
      state,
      { compact: true },
    ));
  }

  if (state.assistantStream.active) {
    panels.push(renderOutputPanel(
      "assistant",
      renderAssistantDraft(state.assistantStream.buffer),
      state,
    ));
  }

  clearLiveRegions(state);
  if (panels.length === 0) {
    return;
  }

  const rendered = `${panels.join("\n")}\n`;
  process.stdout.write(rendered);
  state.liveRegionLines = countRenderedTerminalLines(rendered, state);
  state.liveRegionRendered = rendered;
  state.liveRegionLastDrawAt = Date.now();
}

function collapseTrace(state) {
  const entries = state.trace.activeEntries.length > 0 ? [...state.trace.activeEntries] : [];
  const analysisSections = state.trace.activeAnalysisSections.length > 0
    ? [...state.trace.activeAnalysisSections]
    : [];

  if (entries.length === 0 && analysisSections.length === 0) {
    return;
  }

  clearLiveRegions(state);
  state.trace.lastEntries = entries;
  state.trace.lastAnalysisSections = analysisSections;
  state.trace.activeEntries = [];
  state.trace.activeAnalysisSections = [];
  if (entries.length > 0) {
    console.log(renderOutputPanel("info", renderTraceSummary(entries, analysisSections), state));
  }
}

function beginTraceTurn(state) {
  state.trace.activeEntries = [];
  state.trace.activeAnalysisSections = [];
  state.liveRegionLines = 0;
  state.runtimeStatus.activity = "thinking";
  state.runtimeStatus.mode = "thinking";
  resetAnalysisStream(state);
  resetAssistantStream(state);
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

async function submitUserMessage(state, input) {
  beginTraceTurn(state);
  state.activeTurnAbortController = new AbortController();
  state.activeTurnAbortSignal = state.activeTurnAbortController.signal;
  state.turnInFlight = true;
  try {
    const response = await runAgentTurn(state, input.trim());
    collapseTrace(state);
    clearLiveRegions(state);
    resetAnalysisStream(state);
    resetAssistantStream(state);
    state.runtimeStatus.mode = "idle";
    state.runtimeStatus.activity = "idle";
    state.lastAssistantResponse = response || "";
    console.log(renderOutputPanel(
      "assistant",
      renderAssistantResponse(response, state.useColor),
      state,
    ));
  } catch (error) {
    if (isAbortError(error)) {
      if (state.analysisStream.buffer.trim()) {
        persistAnalysisBuffer(state);
      }
      markPendingToolEntriesCancelled(state);
      collapseTrace(state);
      clearLiveRegions(state);
      const partialAssistant = state.assistantStream.buffer.trim();
      resetAnalysisStream(state);
      resetAssistantStream(state);
      state.runtimeStatus.mode = "interrupted";
      state.runtimeStatus.activity = "request interrupted";
      if (partialAssistant) {
        state.lastAssistantResponse = partialAssistant;
        console.log(renderOutputPanel(
          "assistant",
          renderAssistantResponse(partialAssistant, state.useColor),
          state,
        ));
      }
      console.log(renderOutputPanel("info", "Request interrupted.", state));
      return;
    }

    collapseTrace(state);
    clearLiveRegions(state);
    resetAnalysisStream(state);
    resetAssistantStream(state);
    state.runtimeStatus.mode = "idle";
    state.runtimeStatus.activity = "idle";
    throw error;
  } finally {
    state.turnInFlight = false;
    state.activeTurnAbortController = null;
    state.activeTurnAbortSignal = null;
  }
}

async function withLoading(state, label, task, doneLabel = "Done") {
  state.spinner.start(label);
  try {
    return await task();
  } finally {
    state.spinner.stop(renderSpinnerDone(doneLabel));
  }
}

function startSelectionMode(state, kind) {
  state.selectionMode = {
    kind,
    index: 0,
    options: getSelectionOptions(state, kind),
  };
  printSelectionMode(state);
}

function getSelectionOptions(state, kind) {
  if (kind === "api") {
    return state.sessionState.recentBaseUrls.map((url) => ({
      label: url,
      value: url,
    }));
  }

  const options = [];
  const seen = new Set();

  state.lastModels.forEach((model, index) => {
    if (seen.has(model.name)) {
      return;
    }
    seen.add(model.name);
    options.push({
      label: `${index + 1}. ${model.name}`,
      value: model.name,
    });
  });

  state.sessionState.recentModels.forEach((model, index) => {
    if (seen.has(model)) {
      return;
    }
    seen.add(model);
    options.push({
      label: `r${index + 1}. ${model}`,
      value: model,
    });
  });

  return options;
}

function printSelectionMode(state) {
  if (!state.selectionMode) {
    return;
  }

  if (state.selectionMode.kind === "api") {
    const lines = renderApiPicker(
      state.ollama.baseUrl,
      state.sessionState.recentBaseUrls,
      state.selectionMode.index,
    );
    console.log(renderOutputPanel("info", lines, state));
    return;
  }

  const selectedLabel = state.selectionMode.options[state.selectionMode.index]?.label ?? null;
  const lines = renderModelPicker(
    state.activeModel,
    state.sessionState.recentModels,
    state.lastModels,
    selectedLabel,
  );
  console.log(renderOutputPanel("info", lines, state));
}

function moveSelection(state, direction) {
  if (!state.selectionMode || state.selectionMode.options.length === 0) {
    return;
  }

  const max = state.selectionMode.options.length;
  state.selectionMode.index = (state.selectionMode.index + direction + max) % max;
}

async function chooseCurrentSelection(state) {
  if (!state.selectionMode || state.selectionMode.options.length === 0) {
    return false;
  }

  const selected = state.selectionMode.options[state.selectionMode.index];
  if (!selected) {
    return false;
  }

  const commandName = state.selectionMode.kind === "api" ? "api" : "model";
  state.selectionMode = null;
  const fakeCommand = parseCommand(`/${commandName} ${selected.value}`);
  await handleCommand(state, fakeCommand);
  return true;
}

async function resolveSelectionInput(state, rawInput) {
  const input = rawInput.trim();
  const kind = state.selectionMode?.kind;

  if (!kind) {
    return false;
  }

  if (!input) {
    return chooseCurrentSelection(state);
  }

  if (input === "/cancel") {
    state.selectionMode = null;
    console.log(renderOutputPanel("info", "Selection cancelled.", state));
    return true;
  }

  if (kind === "api") {
    state.selectionMode = null;
    const fakeCommand = parseCommand(`/api ${input}`);
    await handleCommand(state, fakeCommand);
    return true;
  }

  if (kind === "model") {
    state.selectionMode = null;
    const fakeCommand = parseCommand(`/model ${input}`);
    await handleCommand(state, fakeCommand);
    return true;
  }

  return false;
}

async function handleCommand(state, command) {
  const { workspace, ollama } = state;

  switch (command.name) {
    case "help":
      console.log(renderHelp());
      return;
    case "api": {
      const nextUrl = command.args[0];
      if (!nextUrl) {
        if (state.useColor) {
          startSelectionMode(state, "api");
        } else {
          console.log(renderRecentBaseUrls(state.ollama.baseUrl, state.sessionState.recentBaseUrls));
        }
        return;
      }

      const byIndex = Number.parseInt(nextUrl, 10);
      const resolvedUrl =
        Number.isFinite(byIndex) && String(byIndex) === nextUrl
          ? state.sessionState.recentBaseUrls[byIndex - 1]
          : nextUrl;

      if (!resolvedUrl) {
        throw new Error(`Endpoint index out of range: ${nextUrl}`);
      }

      state.ollama.setBaseUrl(resolvedUrl);
      state.lastModels = [];
      state.sessionState = await rememberBaseUrl(state.sessionState, state.ollama.baseUrl);
      console.log(renderApiUpdated(state.ollama.baseUrl));
      return;
    }
    case "mount": {
      const target = command.args[0];
      if (!target) {
        console.log(renderMountedWorkspace(workspace.rootPath));
        return;
      }

      const mountedPath = await workspace.mount(target);
      console.log(`Mounted workspace: ${mountedPath}`);
      return;
    }
    case "pwd": {
      console.log(renderMountedWorkspace(workspace.rootPath));
      return;
    }
    case "ls": {
      const userPath = command.args[0] ?? ".";
      const entries = await workspace.list(userPath);
      console.log(renderList(entries, userPath));
      return;
    }
    case "info": {
      const userPath = command.args[0];
      if (!userPath) {
        throw new Error("Usage: /info <path>");
      }

      const info = await workspace.inspect(userPath);
      console.log(renderInfo(info));
      return;
    }
    case "read":
    case "cat": {
      const userPath = command.args[0];
      if (!userPath) {
        throw new Error("Usage: /read <path> [startLine] [endLine]");
      }

      const result = await workspace.readTextFile(userPath, {
        startLine: command.args[1],
        endLine: command.args[2],
      });
      console.log(renderReadResult(result));
      return;
    }
    case "find":
    case "search": {
      const query = command.args[0];
      if (!query) {
        throw new Error("Usage: /find <text> [path]");
      }

      const userPath = command.args[1] ?? ".";
      const result = await workspace.findInFiles(query, userPath);
      console.log(renderFindResults(result));
      return;
    }
    case "models": {
      const models = await withLoading(state, "Loading models...", () => ollama.listModels(), "Model list ready");
      state.lastModels = models;
      console.log(renderModels(models, state.activeModel));
      return;
    }
    case "model": {
      const nextModel = command.args[0];
      if (!nextModel) {
        if (state.useColor) {
          startSelectionMode(state, "model");
        } else {
          console.log(renderRecentModels(state.activeModel, state.sessionState.recentModels, state.lastModels));
        }
        return;
      }

      const isRecentShortcut = /^r\d+$/.test(nextModel);
      const modelByIndex = Number.parseInt(nextModel, 10);
      if (isRecentShortcut) {
        const recentIndex = Number.parseInt(nextModel.slice(1), 10);
        const recentSelected = state.sessionState.recentModels[recentIndex - 1];
        if (!recentSelected) {
          throw new Error(`Recent model index out of range: ${nextModel}.`);
        }
        state.activeModel = recentSelected;
      } else if (Number.isFinite(modelByIndex) && String(modelByIndex) === nextModel) {
        const selected = state.lastModels[modelByIndex - 1];
        const recentSelected = state.sessionState.recentModels[modelByIndex - 1];
        if (!selected && !recentSelected) {
          throw new Error(`Model index out of range: ${nextModel}. Run /models first or use /model to inspect recents.`);
        }
        state.activeModel = selected ? selected.name : recentSelected;
      } else {
        state.activeModel = nextModel;
      }

      state.sessionState = await rememberModel(state.sessionState, state.activeModel);
      console.log(renderModelUpdated(state.activeModel));
      return;
    }
    case "status":
      console.log(renderStatus({
        baseUrl: state.ollama.baseUrl,
        activeModel: state.activeModel,
        rootPath: state.workspace.rootPath,
        messageCount: state.messages.length,
        runtimeStatus: state.runtimeStatus,
      }));
      return;
    case "tools":
      console.log(renderTools(getToolNames()));
      return;
    case "trace": {
      const mode = command.args[0] ?? "close";
      const entries = state.trace.activeEntries.length > 0 ? state.trace.activeEntries : state.trace.lastEntries;
      const analysisSections = state.trace.activeAnalysisSections.length > 0
        ? state.trace.activeAnalysisSections
        : state.trace.lastAnalysisSections;

      if ((!entries || entries.length === 0) && (!analysisSections || analysisSections.length === 0)) {
        console.log(renderOutputPanel("info", "No tool trace available yet.", state));
        return;
      }

      if (mode === "open") {
        console.log(renderOutputPanel("tool", renderTraceExpanded(entries, analysisSections), state));
        return;
      }

      if (mode === "close") {
        console.log(renderOutputPanel("info", renderTraceSummary(entries, analysisSections), state));
        return;
      }

      throw new Error('Usage: /trace [open|close]');
    }
    case "history":
      console.log(renderHistory(state.messages, Number.parseInt(command.args[0] ?? "5", 10)));
      return;
    case "multiline":
      state.multilineMode = true;
      state.multilineBuffer = [];
      console.log(renderOutputPanel("info", renderMultilineIntro(), state));
      return;
    case "send": {
      if (!state.multilineMode) {
        throw new Error("Not in multiline mode. Use /multiline first.");
      }
      const payload = state.multilineBuffer.join("\n").trim();
      if (!payload) {
        console.log(renderOutputPanel("info", renderMultilineBufferEmpty(), state));
        return;
      }
      state.multilineMode = false;
      state.multilineBuffer = [];
      await submitUserMessage(state, payload);
      return;
    }
    case "cancel":
      state.multilineMode = false;
      state.multilineBuffer = [];
      console.log(renderOutputPanel("info", renderMultilineCancelled(), state));
      return;
    case "last":
      if (!state.lastAssistantResponse) {
        console.log(renderOutputPanel("info", renderLastResponseMissing(), state));
        return;
      }
      console.log(renderOutputPanel(
        "assistant",
        renderAssistantResponse(state.lastAssistantResponse, state.useColor),
        state,
      ));
      return;
    case "copy": {
      if (!state.lastAssistantResponse) {
        console.log(renderOutputPanel("info", renderLastResponseMissing(), state));
        return;
      }
      const result = await copyToClipboard(state.lastAssistantResponse);
      console.log(renderOutputPanel("info", renderInfoMessage(result), state));
      return;
    }
    case "clear":
    case "reset":
      state.messages = [];
      state.lastAssistantResponse = "";
      console.log("Chat history cleared.");
      return;
    case "exit":
    case "quit":
      return "exit";
    default:
      throw new Error(`Unknown command: ${command.name}. Type /help to see commands.`);
  }
}

async function main() {
  const sessionState = await loadSessionState();
  const state = {
    workspace: new Workspace(),
    ollama: new OllamaClient(),
    activeModel: getInitialModel() || sessionState.recentModels[0] || "",
    messages: [],
    lastModels: [],
    multilineMode: false,
    multilineBuffer: [],
    lastAssistantResponse: "",
    selectionMode: null,
    useColor: process.stdout.isTTY,
    analysisDisplayMode: getAnalysisDisplayMode(),
    outputColumns: process.stdout.columns ?? 80,
    spinner: new Spinner({ enabled: process.stdout.isTTY }),
    liveRegionLines: 0,
    liveRegionRendered: "",
    liveRegionLastDrawAt: 0,
    liveRegionTimer: null,
    analysisStream: {
      active: false,
      buffer: "",
    },
    assistantStream: {
      active: false,
      buffer: "",
      sawChunks: false,
    },
    runtimeStatus: {
      mode: "idle",
      activity: "idle",
      lastTool: "none",
    },
    trace: {
      activeEntries: [],
      activeAnalysisSections: [],
      lastEntries: [],
      lastAnalysisSections: [],
    },
    nextToolRunId: 1,
    activeTurnAbortController: null,
    activeTurnAbortSignal: null,
    turnInFlight: false,
    sessionState,
    onToolCall(toolCall) {
      state.spinner.stop();
      const args = normalizeToolArgs(toolCall?.function?.arguments);
      state.runtimeStatus.mode = "tool";
      state.runtimeStatus.activity = renderToolCommand(toolCall?.function?.name, args);
      const toolRunId = createToolRunId(state);
      state.trace.activeEntries.push({
        toolRunId,
        toolName: toolCall?.function?.name ?? "unknown_tool",
        command: renderToolCommand(toolCall?.function?.name, args),
        args,
        status: "requested",
        requestedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        result: null,
        error: null,
      });
      const pendingEntry = state.trace.activeEntries.find((entry) => entry.toolRunId === toolRunId);
      if (pendingEntry) {
        pendingEntry.status = "running";
        pendingEntry.startedAt = new Date().toISOString();
      }
      drawLiveRegions(state);
      return toolRunId;
    },
    onToolResult(result, toolRunId) {
      if (!result) {
        return;
      }

      const pendingEntry = toolRunId
        ? state.trace.activeEntries.find((entry) => entry.toolRunId === toolRunId)
        : [...state.trace.activeEntries]
          .reverse()
          .find((entry) => entry.toolName === result.toolName && entry.status === "running");

      if (pendingEntry) {
        pendingEntry.status = result.ok ? "success" : "error";
        pendingEntry.completedAt = new Date().toISOString();
        pendingEntry.result = result.data ?? null;
        pendingEntry.error = result.ok ? null : result.data?.error ?? "Unknown tool error";
      }

      state.runtimeStatus.lastTool = result.ok
        ? `${result.toolName} ok`
        : `${result.toolName} failed`;
      state.runtimeStatus.activity = result.ok
        ? "tool complete"
        : "tool failed";

      drawLiveRegions(state);
    },
    onModelRequestStart(label) {
      state.runtimeStatus.mode = "thinking";
      state.runtimeStatus.activity = label.replace(/\.\.\.$/, "").toLowerCase();
      state.spinner.start(label);
    },
    onModelRequestEnd() {
      if (state.assistantStream.sawChunks || state.analysisStream.buffer.trim()) {
        state.spinner.stop();
        return;
      }
      state.spinner.stop(renderSpinnerDone("Response ready"));
    },
    onAssistantStreamStart() {
      resetAssistantStream(state);
    },
    onAssistantStreamChunk(chunk) {
      state.spinner.stop();
      state.assistantStream.active = true;
      state.assistantStream.sawChunks = true;
      state.runtimeStatus.mode = "stream";
      state.runtimeStatus.activity = "assistant response";
      state.assistantStream.buffer += chunk;
      scheduleLiveRegions(state);
    },
    onAssistantStreamDiscard() {
      resetAssistantStream(state);
      drawLiveRegions(state);
      state.runtimeStatus.mode = "tool";
    },
    onAssistantStreamComplete() {
      state.runtimeStatus.mode = "idle";
      state.runtimeStatus.activity = "idle";
    },
    onAnalysisStreamStart() {
      resetAnalysisStream(state);
    },
    onAnalysisStreamChunk(chunk) {
      state.analysisStream.buffer += chunk;
      if (state.analysisDisplayMode === "live") {
        state.spinner.stop();
        state.analysisStream.active = true;
      }
      if (state.analysisDisplayMode === "live" && !state.assistantStream.sawChunks) {
        state.runtimeStatus.mode = "analysis";
        state.runtimeStatus.activity = "reasoning";
        scheduleLiveRegions(state);
      }
    },
    onAnalysisStreamHold() {
      persistAnalysisBuffer(state);
      drawLiveRegions(state);
    },
    onAnalysisStreamComplete() {
      persistAnalysisBuffer(state);
      drawLiveRegions(state);
    },
  };

  if (!process.env.OLLAMA_BASE_URL && sessionState.recentBaseUrls[0]) {
    state.ollama.setBaseUrl(sessionState.recentBaseUrls[0]);
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY && process.stdout.isTTY,
    completer: createCompleter(),
  });

  if (process.argv[2]) {
    try {
      await state.workspace.mount(process.argv[2]);
    } catch (error) {
      console.error(`Failed to mount startup directory: ${error.message}`);
    }
  }

  state.sessionState = await rememberBaseUrl(state.sessionState, state.ollama.baseUrl);
  if (state.activeModel) {
    state.sessionState = await rememberModel(state.sessionState, state.activeModel);
  }

  printWelcome(state);

  let handleResize = null;

  try {
    handleResize = () => {
      state.outputColumns = process.stdout.columns ?? 80;

      if (!rl.terminal) {
        return;
      }

      if (state.liveRegionLines > 0 || state.liveRegionRendered) {
        clearLiveRegions(state);
        drawLiveRegions(state);
      }

      rl.setPrompt(getPrompt(state));
      rl.prompt(true);
    };

    if (process.stdout.isTTY) {
      process.stdout.on("resize", handleResize);
    }

    if (rl.terminal) {
      readline.emitKeypressEvents(process.stdin, rl);
      if (typeof process.stdin.setRawMode === "function") {
        process.stdin.setRawMode(true);
      }
      process.stdin.on("keypress", (_str, key) => {
        if (key?.ctrl && key.name === "c") {
          if (state.turnInFlight && state.activeTurnAbortController) {
            state.spinner.stop();
            state.activeTurnAbortController.abort();
            return;
          }

          rl.close();
          return;
        }

        if (key?.ctrl && key.name === "l") {
          clearScreen(rl, state);
          return;
        }

        if (!state.selectionMode) {
          return;
        }

        if (key?.name === "up") {
          moveSelection(state, -1);
          clearScreen(rl, state);
          return;
        }

        if (key?.name === "down") {
          moveSelection(state, 1);
          clearScreen(rl, state);
        }
      });
      rl.setPrompt(getPrompt(state));
      rl.prompt();
    }

    for await (const input of rl) {
      if (state.selectionMode) {
        const handled = await resolveSelectionInput(state, input);
        if (handled) {
          console.log("");
          if (rl.terminal) {
            rl.setPrompt(getPrompt(state));
            rl.prompt();
          }
          continue;
        }
      }

      if (state.multilineMode && !input.trim().startsWith("/")) {
        state.multilineBuffer.push(input);
        if (rl.terminal) {
          rl.setPrompt(getPrompt(state));
          rl.prompt();
        }
        continue;
      }

      const command = parseCommand(input);

      if (!command) {
        if (rl.terminal) {
          rl.setPrompt(getPrompt(state));
          rl.prompt();
        }
        continue;
      }

      try {
        if (input.trim().startsWith("/")) {
          const result = await handleCommand(state, command);
          if (result === "exit") {
            break;
          }
        } else {
          await submitUserMessage(state, input.trim());
        }
      } catch (error) {
        console.error(renderOutputPanel(
          "error",
          renderErrorMessage(error.message),
          state,
        ));
      }

      console.log("");

      if (rl.terminal) {
        rl.setPrompt(getPrompt(state));
        rl.prompt();
      }
    }
  } finally {
    state.spinner.stop();
    if (process.stdout.isTTY && handleResize) {
      process.stdout.off("resize", handleResize);
    }
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    rl.close();
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exitCode = 1;
});

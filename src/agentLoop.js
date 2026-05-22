import { executeToolCall, getToolDefinitions, getToolNames } from "./toolRegistry.js";

const MAX_TOOL_ITERATIONS = 6;
const MUTATION_TOOL_NAMES = new Set(["write_file", "replace_in_file"]);
const READ_TOOL_NAMES = new Set(["read_file"]);
const SEARCH_TOOL_NAMES = new Set(["find_in_files"]);

const TOOL_GATE_KINDS = {
  mutation: "mutation",
  read: "read",
  search: "search",
};

function looksLikeFileMutationRequest(userInput) {
  const input = String(userInput ?? "");
  const asksToWrite = /(创建|新建|写入|写一份|写一个|保存|生成|修改|更新|替换|edit|modify|update|replace|create|write|save)/i.test(input);
  const mentionsFileTarget =
    /(workspace|文件|file|代码|\.py|\.txt|\.js|\.ts|\.json|\.md|\.sh)/i.test(input);

  return asksToWrite && mentionsFileTarget;
}

function looksLikeReadInspectionRequest(userInput) {
  const input = String(userInput ?? "");
  const asksToRead =
    /(读取|查看|看一下|看看|读一下|打开|解释|分析|讲讲|review|read|open|inspect|explain|analyze|summari[sz]e)/i.test(input);
  const mentionsProjectFact =
    /(workspace|文件|file|代码|函数|类|模块|符号|path|src\/|README|package\.json|\.py|\.js|\.ts|\.md|\.json|\.txt|\.sh)/i.test(input);

  return asksToRead && mentionsProjectFact;
}

function looksLikeSearchRequest(userInput) {
  const input = String(userInput ?? "");
  const asksToSearch =
    /(搜索|查找|找一下|找出|定位|grep|find|search|where|reference|references|occurrence|occurrences|match|matches|定义|引用)/i.test(input);
  const mentionsQueryTarget =
    /(workspace|文件|file|代码|函数|类|模块|符号|TODO|FIXME|path|src\/|README|package\.json|\.py|\.js|\.ts|\.md|\.json|\.txt|\.sh)/i.test(input);

  return asksToSearch && mentionsQueryTarget;
}

function hasMutationToolResult(toolResults) {
  return toolResults.some((result) => {
    return isSuccessfulMutationResult(result);
  });
}

function isSuccessfulMutationResult(result) {
  return result?.ok && MUTATION_TOOL_NAMES.has(result?.toolName);
}

function hasSuccessfulToolResult(toolResults, toolNames) {
  return toolResults.some((result) => result?.ok && toolNames.has(result?.toolName));
}

function inferRequiredToolGateKinds(userInput) {
  const requiredKinds = new Set();

  if (looksLikeFileMutationRequest(userInput)) {
    requiredKinds.add(TOOL_GATE_KINDS.mutation);
  }

  if (looksLikeReadInspectionRequest(userInput)) {
    requiredKinds.add(TOOL_GATE_KINDS.read);
  }

  if (looksLikeSearchRequest(userInput)) {
    requiredKinds.add(TOOL_GATE_KINDS.search);
  }

  return requiredKinds;
}

function getMissingRequiredToolKinds(toolResults, requiredKinds) {
  const missing = [];

  if (requiredKinds.has(TOOL_GATE_KINDS.mutation) && !hasMutationToolResult(toolResults)) {
    missing.push(TOOL_GATE_KINDS.mutation);
  }

  if (requiredKinds.has(TOOL_GATE_KINDS.read) && !hasSuccessfulToolResult(toolResults, READ_TOOL_NAMES)) {
    missing.push(TOOL_GATE_KINDS.read);
  }

  if (requiredKinds.has(TOOL_GATE_KINDS.search) && !hasSuccessfulToolResult(toolResults, SEARCH_TOOL_NAMES)) {
    missing.push(TOOL_GATE_KINDS.search);
  }

  return missing;
}

function buildMutationRetryPrompt(userInput) {
  return [
    "The user asked you to change files in the mounted workspace.",
    `Original request: ${userInput}`,
    "You must perform the requested file change now by calling write_file or replace_in_file.",
    "If the user asked for tables or code blocks in the reply, keep those in the terminal response, not in the source file contents.",
    "When writing a source code file, write only valid file contents. Do not include Markdown headings, tables, or fenced code blocks unless the target file is itself Markdown.",
    "Do not only describe what you plan to do.",
  ].join(" ");
}

function buildRequiredToolRetryPrompt(userInput, missingKinds) {
  const instructions = [];

  if (missingKinds.includes(TOOL_GATE_KINDS.mutation)) {
    instructions.push("You must perform the requested file change now by calling write_file or replace_in_file.");
  }

  if (missingKinds.includes(TOOL_GATE_KINDS.read)) {
    instructions.push("Before answering, you must inspect the relevant workspace file contents with read_file.");
  }

  if (missingKinds.includes(TOOL_GATE_KINDS.search)) {
    instructions.push("Before answering, you must search the workspace with find_in_files.");
  }

  return [
    "Your previous answer did not establish the required workspace facts through tools.",
    `Original request: ${userInput}`,
    ...instructions,
    "Do not only describe what you plan to do.",
  ].join(" ");
}

function buildPostMutationFinalPrompt(userInput, toolResults) {
  const mutations = toolResults
    .filter(isSuccessfulMutationResult)
    .map((result) => {
      const data = result.data ?? {};
      const action = result.toolName === "replace_in_file"
        ? "updated"
        : data.created
          ? "created"
          : "updated";
      const details = [
        `${action}: ${data.path ?? "(unknown path)"}`,
        typeof data.bytesWritten === "number" ? `${data.bytesWritten} bytes` : null,
        typeof data.lineCount === "number" ? `${data.lineCount} lines` : null,
        typeof data.replacements === "number" ? `${data.replacements} replacements` : null,
      ].filter(Boolean);

      return `- ${details.join(", ")}`;
    });

  return [
    "The requested workspace file change has already succeeded.",
    `Original user request: ${userInput}`,
    "Successful file changes:",
    ...mutations,
    "Now write the final answer only.",
    "Do not request or describe any further tool calls.",
    "If the user asked for a table or code block, include it in this final terminal answer.",
    "Keep the answer concise and mention the changed file name.",
  ].join("\n");
}

function buildDeterministicMutationFinal(_userInput, toolResults) {
  const mutations = toolResults.filter(isSuccessfulMutationResult);
  if (mutations.length === 0) {
    return "";
  }

  const rows = mutations.map((result) => {
    const data = result.data ?? {};
    const action = result.toolName === "replace_in_file"
      ? "updated"
      : data.created
        ? "created"
        : "updated";
    const details = [
      `${data.path ?? "(unknown path)"}`,
      action,
      typeof data.lineCount === "number" ? `${data.lineCount} lines` : null,
      typeof data.replacements === "number" ? `${data.replacements} replacements` : null,
    ].filter(Boolean);

    return `- ${details.join(", ")}`;
  });

  return [
    "文件已写入。",
    "",
    ...rows,
  ].join("\n");
}

function buildSystemMessage(workspace) {
  const mounted = workspace.rootPath ?? "unmounted";
  return {
    role: "system",
    content: [
      "You are a local coding agent running in a terminal.",
      `Current mounted workspace: ${mounted}.`,
      "You can inspect and modify the workspace only through the provided tools.",
      "For project-specific questions, prefer using tools instead of guessing.",
      "If the user asks to create or edit files, use write_file or replace_in_file instead of claiming the change happened.",
      "Never say a file was created, edited, or verified unless a tool call succeeded.",
      "If a tool returns an error, explain the failure clearly and do not pretend the task completed.",
      "After a successful file write or replacement, reply with a short confirmation that names the file and summarizes the change.",
      "Do not automatically paste the full file contents, full code block, or long expected output unless the user explicitly asks to see them.",
      "If the user wants tables or code blocks in your reply, that affects the terminal response only, not the file contents.",
      "When writing source code files such as .py, .js, .ts, .tsx, .jsx, .java, .c, .cpp, .go, .rs, or .sh, write valid source code only.",
      "Do not write Markdown headings, Markdown tables, fenced code blocks, or prose explanations into source code files unless the target file is a Markdown or text document.",
      "Default to short, direct CLI-style responses.",
      "Do not use emojis or enthusiastic filler unless the user explicitly asks for that tone.",
      "Do not repeat metadata, tool traces, file sizes, or file paths that the UI already showed unless the user asks for them.",
      "Prefer a brief conclusion plus the next useful step over a long explanation.",
      "If the workspace is unmounted and the user asks about project files, explain that no workspace is mounted yet.",
      "Keep answers concise and practical.",
    ].join(" "),
  };
}

function normalizeAssistantMessage(message, toolCalls = null) {
  const directToolCalls = message?.tool_calls ?? [];
  const normalizedToolCalls = toolCalls ?? directToolCalls;
  const inferredToolCallOnly = directToolCalls.length === 0 && normalizedToolCalls.length > 0;

  return {
    role: "assistant",
    content: inferredToolCallOnly ? "" : message?.content ?? "",
    ...(normalizedToolCalls.length > 0 ? { tool_calls: normalizedToolCalls } : {}),
  };
}

export function extractToolCalls(message) {
  const directToolCalls = message?.tool_calls ?? [];
  if (directToolCalls.length > 0) {
    return normalizeInferredToolCalls(directToolCalls);
  }

  const content = message?.content ?? "";
  return inferToolCallsFromContent(content);
}

function inferToolCallsFromContent(content) {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) {
    return [];
  }

  const candidates = [
    ...extractTaggedToolPayloads(trimmed),
    ...extractFencedJsonPayloads(trimmed),
    ...extractInlineJsonPayloads(trimmed),
    trimmed,
  ];

  for (const candidate of candidates) {
    const normalized = parseCandidateToolCalls(candidate);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
}

function extractTaggedToolPayloads(content) {
  const payloads = [];
  const pattern = /<tool_calls?>\s*([\s\S]*?)\s*<\/tool_calls?>/gi;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    if (match[1]?.trim()) {
      payloads.push(match[1].trim());
    }
  }

  return payloads;
}

function extractFencedJsonPayloads(content) {
  const payloads = [];
  const pattern = /```(?:json|tool_call|tool_calls)?\s*([\s\S]*?)\s*```/gi;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    if (match[1]?.trim()) {
      payloads.push(match[1].trim());
    }
  }

  return payloads;
}

function extractInlineJsonPayloads(content) {
  const payloads = [];
  const starts = [];

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{" || char === "[") {
      starts.push(index);
    }
  }

  for (const start of starts) {
    const payload = readBalancedJsonPayload(content, start);
    if (payload) {
      payloads.push(payload);
    }

    if (payloads.length >= 20) {
      break;
    }
  }

  return payloads;
}

function readBalancedJsonPayload(content, start) {
  const opening = content[start];
  const expectedClosing = opening === "{" ? "}" : "]";
  const stack = [expectedClosing];
  let inString = false;
  let escaped = false;

  for (let index = start + 1; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (char !== stack.pop()) {
        return null;
      }

      if (stack.length === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return null;
}

function parseCandidateToolCalls(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    const normalized = normalizeInferredToolCalls(parsed);
    if (normalized.length > 0) {
      return normalized;
    }
  } catch {
    // ignore parse failures and continue
  }

  return [];
}

function normalizeInferredToolCalls(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeInferredToolCalls(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value.tool_calls)) {
    return normalizeInferredToolCalls(value.tool_calls);
  }

  if (value.tool_call) {
    return normalizeInferredToolCalls(value.tool_call);
  }

  const toolNames = new Set(getToolNames());
  const name = value.name ?? value.tool ?? value.function?.name;
  const args = value.arguments ?? value.args ?? value.parameters ?? value.function?.arguments ?? {};

  if (!name || !toolNames.has(name)) {
    return [];
  }

  return [{
    type: "function",
    function: {
      name,
      arguments: args,
    },
  }];
}

export async function runAgentTurn(state, userInput) {
  if (!state.activeModel) {
    throw new Error("No active model configured. Set OLLAMA_MODEL or use /model <name>.");
  }

  const historyLength = state.messages.length;
  const messages = [
    buildSystemMessage(state.workspace),
    ...state.messages,
    {
      role: "user",
      content: userInput,
    },
  ];
  const tools = getToolDefinitions();
  const toolResults = [];
  let finalContent = "";
  const retryUsedKinds = new Set();
  let finalizingAfterMutation = false;
  const requiredToolGateKinds = inferRequiredToolGateKinds(userInput);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
    state.onModelRequestStart?.(iteration === 0 ? "Thinking..." : "Thinking after tool call...");
    let response;
    try {
      if (typeof state.ollama.chatStream === "function") {
        state.onAssistantStreamStart?.();
        state.onAnalysisStreamStart?.();
        response = await state.ollama.chatStream({
          model: state.activeModel,
          messages,
          tools: finalizingAfterMutation ? [] : tools,
          signal: state.activeTurnAbortSignal,
          onThinkingChunk(chunk) {
            state.onAnalysisStreamChunk?.(chunk);
          },
          onChunk(chunk) {
            state.onAssistantStreamChunk?.(chunk);
          },
        });
      } else {
        response = await state.ollama.chat({
          model: state.activeModel,
          messages,
          tools: finalizingAfterMutation ? [] : tools,
          signal: state.activeTurnAbortSignal,
        });
      }
    } finally {
      state.onModelRequestEnd?.();
    }

    const toolCalls = finalizingAfterMutation ? [] : extractToolCalls(response.message);
    const assistantMessage = normalizeAssistantMessage(response.message, toolCalls);
    messages.push(assistantMessage);
    if (toolCalls.length === 0) {
      const missingKinds = getMissingRequiredToolKinds(toolResults, requiredToolGateKinds);
      const retryableMissingKinds = missingKinds
        .filter((kind) => !retryUsedKinds.has(kind));

      if (retryableMissingKinds.length > 0) {
        retryableMissingKinds.forEach((kind) => retryUsedKinds.add(kind));
        state.onAssistantStreamDiscard?.();
        messages.push({
          role: "user",
          content: retryableMissingKinds.length === 1 && retryableMissingKinds[0] === TOOL_GATE_KINDS.mutation
            ? buildMutationRetryPrompt(userInput)
            : buildRequiredToolRetryPrompt(userInput, retryableMissingKinds),
        });
        continue;
      }

      if (missingKinds.length > 0) {
        throw new Error(`Model did not establish required tool facts before answering: ${missingKinds.join(", ")}.`);
      }

      finalContent = response.content ?? "";
      if (!finalContent && finalizingAfterMutation) {
        finalContent = buildDeterministicMutationFinal(userInput, toolResults);
      }
      state.onAnalysisStreamComplete?.();
      state.onAssistantStreamComplete?.(finalContent);
      break;
    }

    state.onAnalysisStreamHold?.();
    state.onAssistantStreamDiscard?.();

    for (const toolCall of toolCalls) {
      const toolRunId = state.onToolCall?.(toolCall);
      const result = await executeToolCall(state.workspace, toolCall);
      toolResults.push(result);
      state.onToolResult?.(result, toolRunId);
      messages.push({
        role: "tool",
        tool_name: result.toolName,
        content: result.content,
      });
    }

    if (hasMutationToolResult(toolResults)) {
      finalizingAfterMutation = true;
      messages.push({
        role: "user",
        content: buildPostMutationFinalPrompt(userInput, toolResults),
      });
    }
  }

  if (!finalContent) {
    finalContent = buildDeterministicMutationFinal(userInput, toolResults);
  }

  if (!finalContent) {
    throw new Error("Model did not produce a final response before reaching the tool loop limit.");
  }

  state.messages.push(
    {
      role: "user",
      content: userInput,
    },
    ...messages.slice(historyLength + 2),
  );

  return finalContent;
}

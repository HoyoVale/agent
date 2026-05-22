function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed;
}

function normalizeToolArguments(argumentsValue) {
  if (!argumentsValue) {
    return {};
  }

  if (typeof argumentsValue === "string") {
    try {
      return JSON.parse(argumentsValue);
    } catch {
      throw new Error(`Tool arguments are not valid JSON: ${argumentsValue}`);
    }
  }

  return argumentsValue;
}

const SOURCE_FILE_EXTENSIONS = new Set([
  ".py",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".kts",
  ".sh",
  ".bash",
  ".zsh",
]);

function looksLikeMarkdownContent(content) {
  const text = String(content ?? "");
  const markdownFence = /^\s*```[\w-]*\s*$/m.test(text);
  const markdownTable = /^\s*\|.+\|\s*$/m.test(text) && /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/m.test(text);

  return markdownFence || markdownTable;
}

function validateSourceFileContent(filePath, content) {
  const normalizedPath = String(filePath ?? "").toLowerCase();
  const extension = normalizedPath.slice(normalizedPath.lastIndexOf("."));
  if (!SOURCE_FILE_EXTENSIONS.has(extension)) {
    return;
  }

  if (looksLikeMarkdownContent(content)) {
    throw new Error(
      `Refusing to write Markdown-style content into source file: ${filePath}. ` +
      "Write plain source code only, without Markdown headings, tables, or fenced code blocks.",
    );
  }
}

export function getToolDefinitions() {
  return [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and directories inside the mounted workspace.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path inside the mounted workspace. Defaults to '.'.",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file from the mounted workspace with line numbers.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path inside the mounted workspace.",
            },
            startLine: {
              type: "integer",
              description: "1-based start line. Optional.",
            },
            endLine: {
              type: "integer",
              description: "1-based end line. Optional.",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "find_in_files",
        description: "Search for text matches across files in the mounted workspace.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text to search for.",
            },
            path: {
              type: "string",
              description: "Relative search root inside the mounted workspace. Defaults to '.'.",
            },
            maxResults: {
              type: "integer",
              description: "Maximum number of matches to return. Optional.",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "inspect_path",
        description: "Inspect metadata for a file or directory in the mounted workspace.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path inside the mounted workspace.",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a text file inside the mounted workspace. Overwrites existing text files after creating a backup.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path inside the mounted workspace.",
            },
            content: {
              type: "string",
              description: "Complete UTF-8 text content to write into the file.",
            },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "replace_in_file",
        description: "Replace literal text in an existing UTF-8 text file inside the mounted workspace. Creates a backup before writing.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative file path inside the mounted workspace.",
            },
            find: {
              type: "string",
              description: "Exact text to search for. Must be non-empty.",
            },
            replace: {
              type: "string",
              description: "Replacement text.",
            },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
  ];
}

export function getToolNames() {
  return getToolDefinitions().map((tool) => tool.function.name);
}

export async function executeToolCall(workspace, toolCall) {
  const toolName = toolCall?.function?.name;
  try {
    const args = normalizeToolArguments(toolCall?.function?.arguments);

    switch (toolName) {
      case "list_dir": {
        const result = await workspace.list(args.path ?? ".");
        return {
          toolName,
          ok: true,
          data: {
            ok: true,
            path: args.path ?? ".",
            entries: result,
          },
          content: safeJson({
            ok: true,
            path: args.path ?? ".",
            entries: result,
          }),
        };
      }
      case "read_file": {
        const result = await workspace.readTextFile(args.path, {
          startLine: args.startLine,
          endLine: args.endLine,
        });
        return {
          toolName,
          ok: true,
          data: {
            ok: true,
            ...result,
          },
          content: safeJson({
            ok: true,
            ...result,
          }),
        };
      }
      case "find_in_files": {
        const result = await workspace.findInFiles(args.query, args.path ?? ".", {
          maxResults: normalizeInteger(args.maxResults, undefined),
        });
        return {
          toolName,
          ok: true,
          data: {
            ok: true,
            ...result,
          },
          content: safeJson({
            ok: true,
            ...result,
          }),
        };
      }
      case "inspect_path": {
        const result = await workspace.inspect(args.path);
        return {
          toolName,
          ok: true,
          data: {
            ok: true,
            ...result,
          },
          content: safeJson({
            ok: true,
            ...result,
          }),
        };
      }
      case "write_file": {
        validateSourceFileContent(args.path, args.content);
        const result = await workspace.writeTextFile(args.path, args.content);
        return {
          toolName,
          ok: true,
          data: {
            ok: true,
            ...result,
          },
          content: safeJson({
            ok: true,
            ...result,
          }),
        };
      }
      case "replace_in_file": {
        if (typeof args.find !== "string" || args.find.length === 0) {
          throw new Error("Replacement 'find' text must be a non-empty string.");
        }
        if (typeof args.replace !== "string") {
          throw new Error("Replacement 'replace' text must be a string.");
        }
        const existing = await workspace.readTextFileContent(args.path);
        const nextContent = existing.content.split(args.find).join(args.replace);
        validateSourceFileContent(args.path, nextContent);
        const result = await workspace.replaceInFile(args.path, args.find, args.replace);
        return {
          toolName,
          ok: true,
          data: {
            ok: true,
            ...result,
          },
          content: safeJson({
            ok: true,
            ...result,
          }),
        };
      }
      default:
        throw new Error(`Unknown tool call requested by model: ${toolName}`);
    }
  } catch (error) {
    return {
      toolName: toolName ?? "unknown_tool",
      ok: false,
      data: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      content: safeJson({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

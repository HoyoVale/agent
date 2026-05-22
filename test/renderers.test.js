import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAnalysisDraft,
  renderAnalysisFinal,
  renderAssistantResponse,
  renderTraceActivity,
  renderTraceSummary,
} from "../src/renderers.js";

test("renderAssistantResponse preserves code block fences", () => {
  const rendered = renderAssistantResponse([
    "Example:",
    "```python",
    "print(\"Hello, World!\")",
    "```",
  ].join("\n"), false);

  assert.match(rendered, /```python/);
  assert.match(rendered, /print\("Hello, World!"\)/);
  assert.match(rendered, /```\s*$/);
  assert.match(rendered, /Example:\n\n```python/);
});

test("renderAnalysisFinal trims and truncates noisy thinking text", () => {
  const rendered = renderAnalysisFinal("  one\n\n two   three  ", 80);
  assert.equal(rendered, "one two three");

  const truncated = renderAnalysisFinal("x".repeat(100), 20);
  assert.match(truncated, /^x{17}\.\.\./);
  assert.match(truncated, /trace open/);
});

test("renderAnalysisDraft keeps analysis as a short multi-line preview", () => {
  const rendered = renderAnalysisDraft(
    "用户要求在当前 workspace 里创建一个 hello world 文件，同时还希望回答保留表格和代码块，所以我需要先写入文件，再准备终端里的展示内容。",
  );

  const lines = rendered.split("\n");
  assert.ok(lines.length <= 2);
  assert.ok(lines.every((line) => line.length <= 72));
});

test("renderTraceActivity shows a command stream with current and recent tool results", () => {
  const rendered = renderTraceActivity([
    { command: "$ ls .", status: "success" },
    { command: "$ write hello.py <29 bytes>", status: "success" },
    { command: "$ read hello.py:1-20", status: "running" },
  ]);

  assert.match(rendered, /^  ok  ls \./m);
  assert.match(rendered, /^  ok  write hello\.py <29 bytes>/m);
  assert.match(rendered, /^\$ read hello\.py:1-20/m);
});

test("renderTraceActivity shows cancelled entries from the lifecycle ledger", () => {
  const rendered = renderTraceActivity([
    { command: "$ write hello.py <29 bytes>", status: "success" },
    { command: "$ read hello.py:1-20", status: "cancelled" },
  ]);

  assert.match(rendered, /^ok  write hello\.py <29 bytes>/m);
  assert.match(rendered, /^can read hello\.py:1-20/m);
});

test("renderTraceSummary keeps terminal-style tool result lines", () => {
  const rendered = renderTraceSummary([
    { command: "$ write hello.py <29 bytes>", status: "success", result: { path: "hello.py" } },
    { command: "$ read hello.py:1-20", status: "error", result: null },
  ], ["captured reasoning"]);

  assert.match(rendered, /^ok  write hello\.py <29 bytes>/m);
  assert.match(rendered, /^err read hello\.py:1-20/m);
  assert.match(rendered, /analysis: 1 segment captured/);
  assert.match(rendered, /2 tool calls complete \(1 ok, 1 failed, 0 cancelled\)/);
});

test("renderAssistantResponse keeps blank lines around ASCII tables", () => {
  const rendered = renderAssistantResponse([
    "Before",
    "| 文件 | 操作 |",
    "| --- | --- |",
    "| hello.py | created |",
    "After",
  ].join("\n"), false);

  assert.match(rendered, /Before\n\n\+/);
  assert.match(rendered, /\+\n\nAfter/);
});

test("renderAssistantResponse strips leaked think tags from the final output", () => {
  const rendered = renderAssistantResponse([
    "<think>internal reasoning</think>",
    "",
    "已读取 `notes.txt`。",
    "</think>",
  ].join("\n"), false);

  assert.doesNotMatch(rendered, /<\/?think>/);
  assert.match(rendered, /已读取 `notes\.txt`。/);
});

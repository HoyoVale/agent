import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractToolCalls, runAgentTurn } from "../src/agentLoop.js";
import { Workspace } from "../src/workspace.js";

function firstTool(message) {
  const calls = extractToolCalls(message);
  assert.equal(calls.length, 1);
  return calls[0];
}

test("extractToolCalls keeps direct Ollama tool calls", () => {
  const call = firstTool({
    tool_calls: [{
      type: "function",
      function: {
        name: "list_dir",
        arguments: { path: "." },
      },
    }],
  });

  assert.equal(call.function.name, "list_dir");
  assert.deepEqual(call.function.arguments, { path: "." });
});

test("extractToolCalls accepts fenced JSON tool calls", () => {
  const call = firstTool({
    content: [
      "```json",
      JSON.stringify({
        tool_calls: [{
          function: {
            name: "write_file",
            arguments: { path: "hello.py", content: "print('hi')\n" },
          },
        }],
      }),
      "```",
    ].join("\n"),
  });

  assert.equal(call.function.name, "write_file");
  assert.deepEqual(call.function.arguments, { path: "hello.py", content: "print('hi')\n" });
});

test("extractToolCalls accepts tagged and inline JSON payloads", () => {
  const tagged = firstTool({
    content: '<tool_call>{"tool":"inspect_path","args":{"path":"README.md"}}</tool_call>',
  });
  assert.equal(tagged.function.name, "inspect_path");
  assert.deepEqual(tagged.function.arguments, { path: "README.md" });

  const inline = firstTool({
    content: 'I will call {"name":"find_in_files","parameters":{"query":"TODO","path":"src"}} now.',
  });
  assert.equal(inline.function.name, "find_in_files");
  assert.deepEqual(inline.function.arguments, { query: "TODO", path: "src" });
});

test("runAgentTurn switches to a no-tool final response after a successful write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-"));
  const workspace = new Workspace();
  await workspace.mount(root);

  const calls = [];
  const state = {
    activeModel: "fake-model",
    workspace,
    messages: [],
    ollama: {
      async chatStream(request) {
        calls.push(request);
        if (calls.length === 1) {
          assert.ok(request.tools.length > 0);
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                function: {
                  name: "write_file",
                  arguments: {
                    path: "hello.py",
                    content: "# generated example\nprint(\"Hello, World!\")\n",
                  },
                },
              }],
            },
            content: "",
          };
        }

        assert.deepEqual(request.tools, []);
        return {
          message: {
            role: "assistant",
            content: [
              "已创建 `hello.py`。",
              "",
              "| 文件 | 语言 |",
              "| --- | --- |",
              "| hello.py | Python |",
              "",
              "```python",
              "print(\"Hello, World!\")",
              "```",
            ].join("\n"),
          },
          content: [
            "已创建 `hello.py`。",
            "",
            "| 文件 | 语言 |",
            "| --- | --- |",
            "| hello.py | Python |",
            "",
            "```python",
            "print(\"Hello, World!\")",
            "```",
          ].join("\n"),
        };
      },
    },
  };

  const response = await runAgentTurn(state, "请写一份 Python hello world，回答带表格和代码块");

  assert.equal(calls.length, 2);
  assert.match(response, /hello\.py/);
  assert.match(response, /```python/);
  assert.equal(await readFile(path.join(root, "hello.py"), "utf8"), "# generated example\nprint(\"Hello, World!\")\n");
});

test("runAgentTurn deterministic mutation fallback stays grounded in tool facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-fallback-"));
  const workspace = new Workspace();
  await workspace.mount(root);

  const state = {
    activeModel: "fake-model",
    workspace,
    messages: [],
    ollama: {
      async chatStream(request) {
        if (request.tools.length > 0) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                function: {
                  name: "write_file",
                  arguments: {
                    path: "hello.py",
                    content: "print('hi')\n",
                  },
                },
              }],
            },
            content: "",
          };
        }

        return {
          message: {
            role: "assistant",
            content: "",
          },
          content: "",
        };
      },
    },
  };

  const response = await runAgentTurn(state, "请写一份 Python hello world");

  assert.match(response, /^文件已写入。/);
  assert.match(response, /- hello\.py, created/);
  assert.doesNotMatch(response, /```python/);
  assert.doesNotMatch(response, /Hello, World!/);
});

test("runAgentTurn retries until a read_file tool establishes file facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-read-"));
  const workspace = new Workspace();
  await workspace.mount(root);
  await writeFile(path.join(root, "notes.txt"), "hello\nworld\n");

  const calls = [];
  const state = {
    activeModel: "fake-model",
    workspace,
    messages: [],
    ollama: {
      async chatStream(request) {
        calls.push(request);
        if (calls.length === 1) {
          return {
            message: {
              role: "assistant",
              content: "我看了 notes.txt，里面有两行内容。",
            },
            content: "我看了 notes.txt，里面有两行内容。",
          };
        }

        if (calls.length === 2) {
          assert.match(calls[1].messages.at(-1).content, /read_file/);
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                function: {
                  name: "read_file",
                  arguments: { path: "notes.txt", startLine: 1, endLine: 20 },
                },
              }],
            },
            content: "",
          };
        }

        return {
          message: {
            role: "assistant",
            content: "我读取了 `notes.txt`，里面是两行：hello 和 world。",
          },
          content: "我读取了 `notes.txt`，里面是两行：hello 和 world。",
        };
      },
    },
  };

  const response = await runAgentTurn(state, "请读取并解释 notes.txt 里面的内容");

  assert.equal(calls.length, 3);
  assert.match(response, /notes\.txt/);
  assert.match(response, /hello/);
});

test("runAgentTurn retries until a search tool establishes search facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-loop-search-"));
  const workspace = new Workspace();
  await workspace.mount(root);
  await Promise.all([
    writeFile(path.join(root, "a.txt"), "TODO first\n"),
    writeFile(path.join(root, "b.txt"), "nothing\n"),
  ]);

  const calls = [];
  const state = {
    activeModel: "fake-model",
    workspace,
    messages: [],
    ollama: {
      async chatStream(request) {
        calls.push(request);
        if (calls.length === 1) {
          return {
            message: {
              role: "assistant",
              content: "我查到了 TODO，出现在 a.txt 里。",
            },
            content: "我查到了 TODO，出现在 a.txt 里。",
          };
        }

        if (calls.length === 2) {
          assert.match(calls[1].messages.at(-1).content, /find_in_files/);
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                function: {
                  name: "find_in_files",
                  arguments: { query: "TODO", path: "." },
                },
              }],
            },
            content: "",
          };
        }

        return {
          message: {
            role: "assistant",
            content: "我搜索了 `TODO`，只在 `a.txt` 里找到匹配。",
          },
          content: "我搜索了 `TODO`，只在 `a.txt` 里找到匹配。",
        };
      },
    },
  };

  const response = await runAgentTurn(state, "请搜索 workspace 里 TODO 出现在哪里");

  assert.equal(calls.length, 3);
  assert.match(response, /a\.txt/);
});

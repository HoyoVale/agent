import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeToolCall } from "../src/toolRegistry.js";
import { Workspace } from "../src/workspace.js";

test("write_file allows normal Python comments in source files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-tool-"));
  const workspace = new Workspace();
  await workspace.mount(root);

  const result = await executeToolCall(workspace, {
    function: {
      name: "write_file",
      arguments: {
        path: "example.py",
        content: "# generated example\nprint('hello')\n",
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(path.join(root, "example.py"), "utf8"), "# generated example\nprint('hello')\n");
});

test("replace_in_file refuses Markdown-style content in source files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-tool-"));
  await writeFile(path.join(root, "example.py"), "print('hello')\n");

  const workspace = new Workspace();
  await workspace.mount(root);

  const result = await executeToolCall(workspace, {
    function: {
      name: "replace_in_file",
      arguments: {
        path: "example.py",
        find: "print('hello')",
        replace: "```python\nprint('hello')\n```",
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.data.error, /Refusing to write Markdown-style content/);
  assert.equal(await readFile(path.join(root, "example.py"), "utf8"), "print('hello')\n");
});

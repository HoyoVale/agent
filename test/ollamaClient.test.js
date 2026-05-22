import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { OllamaClient } from "../src/ollamaClient.js";

test("OllamaClient chatStream aborts with a user interrupt error", async () => {
  const server = http.createServer((_req, _res) => {
    // Keep the request open until the client aborts.
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  assert.ok(port);

  const client = new OllamaClient({
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutMs: 60_000,
  });

  const controller = new AbortController();
  const request = client.chatStream({
    model: "fake-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(request, (error) => {
    return error?.code === "EUSERABORT" && error?.name === "AbortError";
  });

  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

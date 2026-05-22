import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_TIMEOUT_MS = 60_000;
const execFileAsync = promisify(execFile);

function createAbortError(message = "Request interrupted by user.") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "EUSERABORT";
  return error;
}

function isAbortError(error) {
  return error?.code === "EUSERABORT" || error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function pickPreferredContent(messageContent, streamedContent) {
  if (typeof messageContent === "string" && messageContent.length > 0) {
    return messageContent;
  }

  const streamed = streamedContent.join("");
  if (streamed.length > 0) {
    return streamed;
  }

  return "";
}

function shouldRetryWithoutStreaming(message, mergedContent, streamedContent) {
  const hasToolCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
  if (hasToolCalls) {
    return false;
  }

  if (mergedContent.trim().length > 0) {
    return false;
  }

  return streamedContent.length === 0;
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildErrorMessage(baseUrl, error) {
  const code = error?.code ?? error?.cause?.code;
  const address = error?.address ?? error?.cause?.address;
  const port = error?.port ?? error?.cause?.port;

  if (code || address || port) {
    const parts = [];
    if (code) {
      parts.push(code);
    }
    if (address && port) {
      parts.push(`${address}:${port}`);
    }
    return `Failed to reach Ollama at ${baseUrl} (${parts.join(" @ ")})`;
  }

  return `Failed to reach Ollama at ${baseUrl}: ${error?.message ?? "unknown error"}`;
}

function requestJson(baseUrl, pathname, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const url = new URL(pathname, baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const req = transport.request(
      url,
      {
        method,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");

          if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
            reject(new Error(`Ollama request failed (${res.statusCode}): ${text || res.statusMessage}`));
            return;
          }

          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(new Error(`Invalid JSON from Ollama: ${error.message}`));
          }
        });
      },
    );

    const abortHandler = () => {
      req.destroy(createAbortError());
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
    });

    req.on("error", (error) => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (isAbortError(error)) {
        reject(createAbortError());
        return;
      }
      reject(new Error(buildErrorMessage(baseUrl, error)));
    });

    if (payload) {
      req.write(payload);
    }

    req.on("close", () => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    });

    req.end();
  });
}

function requestNdjsonStream(
  baseUrl,
  pathname,
  {
    method = "GET",
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onEvent,
    signal,
  } = {},
) {
  const url = new URL(pathname, baseUrl);
  const transport = url.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let settled = false;
    let buffer = "";
    let finalEvent = null;

    const req = transport.request(
      url,
      {
        method,
        headers: {
          accept: "application/x-ndjson, application/json",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            if (settled) {
              return;
            }
            settled = true;
            const text = Buffer.concat(chunks).toString("utf8");
            reject(new Error(`Ollama stream request failed (${res.statusCode}): ${text || res.statusMessage}`));
          });
          return;
        }

        res.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            try {
              const parsed = JSON.parse(trimmed);
              finalEvent = parsed;
              onEvent?.(parsed);
            } catch (error) {
              if (settled) {
                return;
              }
              settled = true;
              req.destroy();
              reject(new Error(`Invalid streaming JSON from Ollama: ${error.message}`));
              return;
            }
          }
        });

        res.on("end", () => {
          if (settled) {
            return;
          }

          const trailing = buffer.trim();
          if (trailing) {
            try {
              const parsed = JSON.parse(trailing);
              finalEvent = parsed;
              onEvent?.(parsed);
            } catch (error) {
              settled = true;
              reject(new Error(`Invalid trailing streaming JSON from Ollama: ${error.message}`));
              return;
            }
          }

          settled = true;
          resolve(finalEvent ?? {});
        });
      },
    );

    const abortHandler = () => {
      if (settled) {
        return;
      }
      settled = true;
      req.destroy(createAbortError());
      reject(createAbortError());
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
    });

    req.on("error", (error) => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (settled) {
        return;
      }
      settled = true;
      if (isAbortError(error)) {
        reject(createAbortError());
        return;
      }
      reject(new Error(buildErrorMessage(baseUrl, error)));
    });

    if (payload) {
      req.write(payload);
    }

    req.on("close", () => {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    });

    req.end();
  });
}

async function requestJsonWithCurl(baseUrl, pathname, { method = "GET", body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const url = new URL(pathname, baseUrl);
  const payload = body ? JSON.stringify(body) : null;
  const args = [
    "--silent",
    "--show-error",
    "--noproxy",
    "*",
    "--max-time",
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "-H",
    "accept: application/json",
  ];

  if (method !== "GET") {
    args.push("-X", method);
  }

  if (payload) {
    args.push(
      "-H",
      "content-type: application/json",
      "--data-binary",
      payload,
    );
  }

  args.push(url.toString());

  try {
    const { stdout } = await execFileAsync("curl", args, {
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    return stdout ? JSON.parse(stdout) : {};
  } catch (error) {
    if (isAbortError(error)) {
      throw createAbortError();
    }
    const stderr = error?.stderr?.toString?.().trim?.();
    if (stderr) {
      throw new Error(`Failed to reach Ollama via curl at ${baseUrl}: ${stderr}`);
    }
    throw new Error(`Failed to reach Ollama via curl at ${baseUrl}: ${error.message}`);
  }
}

async function requestJsonRobust(baseUrl, pathname, options) {
  try {
    return await requestJson(baseUrl, pathname, options);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const message = String(error?.message ?? "");
    const shouldFallback =
      message.includes("ETIMEDOUT") ||
      message.includes("ECONNREFUSED") ||
      message.includes("UND_ERR") ||
      message.includes("Failed to reach Ollama");

    if (!shouldFallback) {
      throw error;
    }

    return requestJsonWithCurl(baseUrl, pathname, options);
  }
}

export class OllamaClient {
  constructor(options = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setBaseUrl(nextBaseUrl) {
    this.baseUrl = trimTrailingSlash(nextBaseUrl);
  }

  async listModels() {
    const data = await requestJsonRobust(this.baseUrl, "/api/tags", {
      timeoutMs: this.timeoutMs,
    });
    return data.models ?? [];
  }

  async chat({ model, messages, tools, signal }) {
    return this.chatOnce({ model, messages, tools, signal });
  }

  async chatOnce({ model, messages, tools, signal }) {
    const data = await requestJsonRobust(this.baseUrl, "/api/chat", {
      method: "POST",
      body: {
        model,
        messages,
        tools,
        stream: false,
      },
      timeoutMs: this.timeoutMs,
      signal,
    });

    const hasToolCalls = Array.isArray(data.message?.tool_calls) && data.message.tool_calls.length > 0;
    const content = pickPreferredContent(data.message?.content, []);

    return {
      model: data.model,
      message: {
        role: data.message?.role ?? "assistant",
        content,
        ...(hasToolCalls ? { tool_calls: data.message.tool_calls } : {}),
      },
      content,
      raw: data,
    };
  }

  async chatStream({ model, messages, tools, onChunk, onThinkingChunk, signal }) {
    const streamedContent = [];

    try {
      const data = await requestNdjsonStream(this.baseUrl, "/api/chat", {
        method: "POST",
        body: {
          model,
          messages,
          tools,
          stream: true,
        },
        timeoutMs: this.timeoutMs,
        signal,
        onEvent(event) {
          const thinkingChunk = event?.message?.thinking ?? "";
          if (thinkingChunk) {
            onThinkingChunk?.(thinkingChunk);
          }

          const chunk = event?.message?.content ?? "";
          if (chunk) {
            streamedContent.push(chunk);
            onChunk?.(chunk);
          }
        },
      });

      const hasToolCalls = Array.isArray(data.message?.tool_calls) && data.message.tool_calls.length > 0;
      const mergedContent = pickPreferredContent(data.message?.content, streamedContent);
      const mergedMessage = {
        role: data.message?.role ?? "assistant",
        content: mergedContent,
        ...(hasToolCalls ? { tool_calls: data.message.tool_calls } : {}),
      };

      if (shouldRetryWithoutStreaming(mergedMessage, mergedContent, streamedContent)) {
        const fallback = await this.chatOnce({ model, messages, tools });
        if (fallback.content) {
          onChunk?.(fallback.content);
        }
        return fallback;
      }

      return {
        model: data.model,
        message: mergedMessage,
        content: mergedContent,
        raw: data,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw createAbortError();
      }
      if (streamedContent.length > 0) {
        throw error;
      }
      const data = await this.chatOnce({ model, messages, tools, signal });
      if (data.content) {
        onChunk?.(data.content);
      }
      return data;
    }
  }
}

export function getInitialModel() {
  return process.env.OLLAMA_MODEL ?? "";
}

import { copyFile, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_END_LINE = 200;
const DEFAULT_MAX_SEARCH_BYTES = 512 * 1024;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const DEFAULT_MAX_WRITE_BYTES = 256 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  return sample.includes(0);
}

function normalizeLineNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function buildBackupPath(targetPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${targetPath}.bak.${stamp}`;
}

export class Workspace {
  #rootPath = null;

  get rootPath() {
    return this.#rootPath;
  }

  isMounted() {
    return this.#rootPath !== null;
  }

  async mount(inputPath) {
    const resolved = path.resolve(inputPath);
    const stats = await stat(resolved);

    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }

    this.#rootPath = resolved;
    return resolved;
  }

  assertMounted() {
    if (!this.#rootPath) {
      throw new Error("No workspace mounted. Use /mount <directory> first.");
    }
  }

  resolvePath(userPath = ".") {
    this.assertMounted();

    const candidate = path.resolve(this.#rootPath, userPath);
    const relativePath = path.relative(this.#rootPath, candidate);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Path escapes mounted workspace: ${userPath}`);
    }

    return candidate;
  }

  toRelativePath(absolutePath) {
    this.assertMounted();
    const relativePath = path.relative(this.#rootPath, absolutePath);
    return relativePath || ".";
  }

  async list(userPath = ".") {
    const targetPath = this.resolvePath(userPath);
    const entries = await readdir(targetPath, { withFileTypes: true });

    return entries
      .map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other",
      }))
      .sort((left, right) => {
        if (left.type !== right.type) {
          return left.type === "dir" ? -1 : 1;
        }

        return left.name.localeCompare(right.name);
      });
  }

  async inspect(userPath) {
    const targetPath = this.resolvePath(userPath);
    const stats = await stat(targetPath);

    return {
      absolutePath: targetPath,
      size: stats.size,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
      modifiedAt: stats.mtime.toISOString(),
    };
  }

  async ensureParentDirectory(userPath) {
    const targetPath = this.resolvePath(userPath);
    const parentPath = path.dirname(targetPath);
    let parentStats;

    try {
      parentStats = await stat(parentPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`Parent directory does not exist: ${this.toRelativePath(parentPath)}`);
      }
      throw error;
    }

    if (!parentStats.isDirectory()) {
      throw new Error(`Parent path is not a directory: ${this.toRelativePath(parentPath)}`);
    }

    return targetPath;
  }

  async readTextFileContent(userPath, maxBytes = DEFAULT_MAX_READ_BYTES) {
    const targetPath = this.resolvePath(userPath);
    const fileStats = await stat(targetPath);

    if (!fileStats.isFile()) {
      throw new Error(`Not a file: ${userPath}`);
    }

    if (fileStats.size > maxBytes) {
      throw new Error(
        `File is too large for safe editing: ${userPath} (${fileStats.size} bytes > ${maxBytes} bytes).`,
      );
    }

    const buffer = await readFile(targetPath);
    if (isBinaryBuffer(buffer)) {
      throw new Error(`Binary file is not supported for text editing: ${userPath}`);
    }

    return {
      absolutePath: targetPath,
      size: fileStats.size,
      content: buffer.toString("utf8"),
    };
  }

  async readTextFile(userPath, options = {}) {
    const targetPath = this.resolvePath(userPath);
    const fileStats = await stat(targetPath);

    if (!fileStats.isFile()) {
      throw new Error(`Not a file: ${userPath}`);
    }

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    const startLine = normalizeLineNumber(options.startLine, 1);
    const requestedEndLine = normalizeLineNumber(options.endLine, DEFAULT_END_LINE);
    const endLine = Math.max(startLine, requestedEndLine);
    const bytesToRead = Math.min(fileStats.size, maxBytes);
    const handle = await open(targetPath, "r");
    const buffer = Buffer.alloc(bytesToRead);

    try {
      await handle.read(buffer, 0, bytesToRead, 0);
    } finally {
      await handle.close();
    }

    if (isBinaryBuffer(buffer)) {
      throw new Error(`Binary file is not supported for text read: ${userPath}`);
    }

    const truncated = fileStats.size > maxBytes;
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    const windowLines = lines.slice(startLine - 1, endLine);
    const numberedLines = windowLines.map((line, index) => {
      const lineNumber = startLine + index;
      return `${String(lineNumber).padStart(4, " ")} | ${line}`;
    });

    return {
      absolutePath: targetPath,
      truncated,
      size: fileStats.size,
      startLine,
      endLine: Math.min(endLine, lines.length),
      totalLinesVisible: lines.length,
      content: numberedLines.join("\n"),
    };
  }

  async findInFiles(query, userPath = ".", options = {}) {
    if (!query) {
      throw new Error("Search query cannot be empty.");
    }

    const root = this.resolvePath(userPath);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_SEARCH_BYTES;
    const maxResults = options.maxResults ?? DEFAULT_MAX_SEARCH_RESULTS;
    const caseSensitive = options.caseSensitive ?? false;
    const results = [];
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();
    let filesScanned = 0;

    const visit = async (absolutePath) => {
      if (results.length >= maxResults) {
        return;
      }

      const entryStats = await stat(absolutePath);

      if (entryStats.isDirectory()) {
        const directoryName = path.basename(absolutePath);
        if (IGNORED_DIRECTORY_NAMES.has(directoryName)) {
          return;
        }

        const entries = await readdir(absolutePath, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) {
            break;
          }

          await visit(path.join(absolutePath, entry.name));
        }
        return;
      }

      if (!entryStats.isFile()) {
        return;
      }

      filesScanned += 1;
      const bytesToRead = Math.min(entryStats.size, maxBytes);
      const handle = await open(absolutePath, "r");
      const buffer = Buffer.alloc(bytesToRead);

      try {
        await handle.read(buffer, 0, bytesToRead, 0);
      } finally {
        await handle.close();
      }

      if (isBinaryBuffer(buffer)) {
        return;
      }

      const text = buffer.toString("utf8");
      const lines = text.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        if (results.length >= maxResults) {
          break;
        }

        const line = lines[index];
        const haystack = caseSensitive ? line : line.toLowerCase();
        const column = haystack.indexOf(normalizedQuery);

        if (column === -1) {
          continue;
        }

        results.push({
          path: this.toRelativePath(absolutePath),
          line: index + 1,
          column: column + 1,
          preview: line.trim(),
        });
      }
    };

    await visit(root);

    return {
      query,
      root: this.toRelativePath(root),
      caseSensitive,
      filesScanned,
      maxResults,
      truncated: results.length >= maxResults,
      results,
    };
  }

  async writeTextFile(userPath, content, options = {}) {
    if (typeof content !== "string") {
      throw new Error("File content must be a string.");
    }

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_WRITE_BYTES;
    const encoded = Buffer.from(content, "utf8");
    if (encoded.length > maxBytes) {
      throw new Error(`Refusing to write large file: ${userPath} (${encoded.length} bytes > ${maxBytes} bytes).`);
    }

    const targetPath = await this.ensureParentDirectory(userPath);
    let existed = false;
    let backupPath = null;

    try {
      const existing = await this.readTextFileContent(userPath, maxBytes);
      existed = true;
      backupPath = buildBackupPath(targetPath);
      await copyFile(existing.absolutePath, backupPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    await writeFile(targetPath, encoded);

    return {
      path: this.toRelativePath(targetPath),
      absolutePath: targetPath,
      bytesWritten: encoded.length,
      created: !existed,
      updated: existed,
      backupPath: backupPath ? this.toRelativePath(backupPath) : null,
      lineCount: content.split(/\r?\n/).length,
    };
  }

  async replaceInFile(userPath, find, replace, options = {}) {
    if (typeof find !== "string" || find.length === 0) {
      throw new Error("Replacement 'find' text must be a non-empty string.");
    }

    if (typeof replace !== "string") {
      throw new Error("Replacement 'replace' text must be a string.");
    }

    const maxBytes = options.maxBytes ?? DEFAULT_MAX_WRITE_BYTES;
    const existing = await this.readTextFileContent(userPath, maxBytes);
    const occurrences = existing.content.split(find).length - 1;

    if (occurrences < 1) {
      throw new Error(`Text not found in file: ${userPath}`);
    }

    const nextContent = existing.content.split(find).join(replace);
    const encoded = Buffer.from(nextContent, "utf8");
    if (encoded.length > maxBytes) {
      throw new Error(
        `Refusing to write large replacement result: ${userPath} (${encoded.length} bytes > ${maxBytes} bytes).`,
      );
    }

    const backupPath = buildBackupPath(existing.absolutePath);
    await copyFile(existing.absolutePath, backupPath);
    await writeFile(existing.absolutePath, encoded);

    return {
      path: this.toRelativePath(existing.absolutePath),
      absolutePath: existing.absolutePath,
      backupPath: this.toRelativePath(backupPath),
      replacements: occurrences,
      bytesWritten: encoded.length,
    };
  }
}

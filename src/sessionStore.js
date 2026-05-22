import { homedir } from "node:os";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const STORE_DIR = path.join(homedir(), ".local-coding-agent");
const STORE_FILE = path.join(STORE_DIR, "session-state.json");
const MAX_RECENTS = 8;

function emptyState() {
  return {
    recentBaseUrls: [],
    recentModels: [],
  };
}

function normalizeState(state) {
  return {
    recentBaseUrls: Array.isArray(state?.recentBaseUrls) ? state.recentBaseUrls.filter(Boolean) : [],
    recentModels: Array.isArray(state?.recentModels) ? state.recentModels.filter(Boolean) : [],
  };
}

function pushRecent(list, value) {
  const next = [value, ...list.filter((item) => item !== value)];
  return next.slice(0, MAX_RECENTS);
}

export async function loadSessionState() {
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return emptyState();
  }
}

export async function saveSessionState(state) {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(normalizeState(state), null, 2));
}

export async function rememberBaseUrl(state, baseUrl) {
  const next = normalizeState(state);
  next.recentBaseUrls = pushRecent(next.recentBaseUrls, baseUrl);
  await saveSessionState(next);
  return next;
}

export async function rememberModel(state, modelName) {
  const next = normalizeState(state);
  next.recentModels = pushRecent(next.recentModels, modelName);
  await saveSessionState(next);
  return next;
}

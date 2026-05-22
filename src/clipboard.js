import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function tryClipboardProgram(command, args, input) {
  try {
    await execFileAsync(command, args, {
      input,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function writeOsc52(text) {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

export async function copyToClipboard(text) {
  const value = String(text ?? "");

  const strategies = [
    () => tryClipboardProgram("wl-copy", [], value),
    () => tryClipboardProgram("xclip", ["-selection", "clipboard"], value),
    () => tryClipboardProgram("xsel", ["--clipboard", "--input"], value),
    () => tryClipboardProgram("pbcopy", [], value),
  ];

  for (const strategy of strategies) {
    // Try available clipboard binaries first.
    if (await strategy()) {
      return "Copied to system clipboard.";
    }
  }

  if (process.stdout.isTTY) {
    writeOsc52(value);
    return "Copied via terminal OSC52 escape sequence.";
  }

  throw new Error("No clipboard integration found. Install wl-copy, xclip, xsel, or pbcopy.");
}

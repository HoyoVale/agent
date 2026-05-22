const FRAMES = ["-", "\\", "|", "/"];

export class Spinner {
  constructor({ enabled }) {
    this.enabled = enabled;
    this.intervalId = null;
    this.frameIndex = 0;
    this.label = "";
    this.startedAt = 0;
  }

  start(label) {
    if (!this.enabled) {
      return;
    }

    this.stop();
    this.label = label;
    this.frameIndex = 0;
    this.startedAt = Date.now();
    this.render();
    this.intervalId = setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % FRAMES.length;
      this.render();
    }, 80);
  }

  stop(summaryLabel) {
    if (!this.enabled) {
      return;
    }

    if (!this.intervalId && !this.startedAt) {
      return;
    }

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const elapsed = this.startedAt ? ((Date.now() - this.startedAt) / 1000).toFixed(1) : null;
    process.stdout.write("\r\u001b[2K");
    if (summaryLabel) {
      process.stdout.write(`${summaryLabel}${elapsed ? ` in ${elapsed}s` : ""}\n`);
    }
    this.startedAt = 0;
  }

  render() {
    process.stdout.write(`\r${FRAMES[this.frameIndex]} ${this.label}`);
  }
}

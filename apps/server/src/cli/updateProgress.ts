import type { PinnedRuntimeProgress } from "../cloud/pinnedRuntime.ts";

/** A single status line below the download bar; redirected output remains plain. */
export function createUpdateProgress(
  output: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr,
) {
  const interactive = output.isTTY && process.env.TERM !== "dumb";
  const color = interactive && !process.env.NO_COLOR;
  const style = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  let stage: PinnedRuntimeProgress["stage"] | undefined;
  let lastDraw = -Infinity;
  let lineOpen = false;
  let downloadLine = false;
  const finish = () => {
    if (lineOpen) output.write(downloadLine ? "\n" : "\r\x1b[2K");
    lineOpen = false;
  };
  const status = (message: string) => {
    finish();
    if (interactive) message = message.slice(0, Math.max(0, (output.columns || 80) - 3));
    output.write(interactive ? `\r\x1b[2K  ${style(2, message)}` : `  ${message}\n`);
    lineOpen = Boolean(interactive);
    downloadLine = false;
  };
  return {
    finish,
    status,
    banner(label: string) {
      if (!interactive) return;
      if ((output.columns || 80) < 42) {
        output.write(`\n  ${style(1, "T3 Code")}\n  ${style(2, label)}\n\n`);
        return;
      }
      const mark = [
        "██████████ ████████ ",
        "    ███       ▄██▀  ",
        "    ███       ████▄ ",
        "    ███    ▄     ███",
        "    ███    ███████▀ ",
      ];
      output.write("\n");
      for (const [index, row] of mark.entries()) {
        const text =
          index === 1
            ? `     ${style(1, "T3 Code")}`
            : index === 2
              ? `     ${style(2, label)}`
              : "";
        output.write(`  ${style(1, row)}${text}\n`);
      }
      output.write("\n");
    },
    heading(message: string, detail = "") {
      finish();
      output.write(`  ${style(2, message)}${detail ? ` ${style(1, detail)}` : ""}\n\n`);
    },
    success(message: string) {
      finish();
      output.write(`  ${style(32, message)}\n\n`);
    },
    report(progress: PinnedRuntimeProgress) {
      if (progress.stage !== stage) {
        stage = progress.stage;
        const labels = {
          download: "Downloading...",
          verify: "Verifying the download...",
          extract: "Extracting T3 Code...",
          validate: "Checking the new executable...",
          cached: "Using the downloaded release...",
        };
        status(labels[stage]);
      }
      if (progress.stage !== "download" || !interactive) return;
      const now = performance.now();
      if (now - lastDraw < 100 && progress.received !== progress.total) return;
      lastDraw = now;
      const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
      const { received, total } = progress;
      const columns = output.columns || 80;
      let line =
        columns >= 32
          ? `  ${style(2, "Downloading")}  ${mb(received)} MB`
          : `  ${mb(received)} MB`.slice(0, Math.max(0, columns - 1));
      if (total !== undefined && total > 0) {
        const percent = Math.min(100, Math.floor((received / total) * 100));
        const width = Math.max(1, Math.min(32, columns - 10));
        const filled = Math.floor((percent * width) / 100);
        line = `  ${style(33, "■".repeat(filled))}${style(2, "·".repeat(width - filled))} ${String(percent).padStart(3)}%`;
        if (columns >= 68) line += `  ${style(2, `${mb(received)} / ${mb(total)} MB`)}`;
      }
      output.write(`\r\x1b[2K${line}`);
      lineOpen = true;
      downloadLine = true;
    },
  };
}

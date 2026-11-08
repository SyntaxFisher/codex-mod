#!/usr/bin/env node
// Records the main Codex window over the DevTools protocol into an MP4 at the
// window's full resolution, while something else drives the app.
//
//   node dev/record.mjs --port 48123 --out demo.mp4 [--seconds 20]
//
// Without --seconds it records until it receives SIGINT or SIGTERM, so it can
// run in the background around any interaction. The DevTools port is 48123
// with the mod and whatever --remote-debugging-port a stock Codex was given.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[index + 1]]] : pairs), []),
);
const PORT = Number(args.port ?? 48123);
const OUT = path.resolve(args.out ?? "recording.mp4");
const SECONDS = args.seconds == null ? null : Number(args.seconds);
const FRAME_INTERVAL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = targets.find((t) => t.type === "page" && /\/index\.html$/.test(t.url));
if (target == null) {
  console.error(`no Codex window on DevTools port ${PORT}`);
  process.exit(1);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

const frames = fs.mkdtempSync(path.join(os.tmpdir(), "codex-record-"));
const stamps = [];
let recording = true;
process.on("SIGINT", () => (recording = false));
process.on("SIGTERM", () => (recording = false));
const started = Date.now();
while (recording && (SECONDS == null || Date.now() - started < SECONDS * 1000)) {
  const at = Date.now();
  const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 92 });
  if (shot.result?.data != null) {
    fs.writeFileSync(path.join(frames, `${String(stamps.length).padStart(6, "0")}.jpg`), Buffer.from(shot.result.data, "base64"));
    stamps.push(at);
  }
  await sleep(Math.max(0, FRAME_INTERVAL_MS - (Date.now() - at)));
}
socket.close();

// Each frame lasts until the next one was taken, so the video keeps real time
// even when a capture took longer than the interval.
const list = stamps
  .map((at, index) => {
    const next = stamps[index + 1] ?? at + FRAME_INTERVAL_MS;
    return `file '${path.join(frames, `${String(index).padStart(6, "0")}.jpg`)}'\nduration ${(next - at) / 1000}`;
  })
  .join("\n");
fs.writeFileSync(path.join(frames, "frames.txt"), list + "\n");
const result = spawnSync(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(frames, "frames.txt"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p", "-r", "30", "-c:v", "libx264", "-crf", "18",
    "-movflags", "+faststart", OUT],
  { encoding: "utf8" },
);
fs.rmSync(frames, { recursive: true, force: true });
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(1);
}
console.log(JSON.stringify({ video: OUT, frames: stamps.length, seconds: (Date.now() - started) / 1000 }));
process.exit(0);

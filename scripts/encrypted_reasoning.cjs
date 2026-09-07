"use strict";

// Reasoning items carry encrypted content that only the organization that
// produced it can read. A thread continued under another profile therefore
// fails its first turn with `invalid_encrypted_content`, and the API names
// only one offending item per attempt. Blanking the encrypted content of
// every reasoning item that another provider produced lets the turn through
// at the cost of the hidden reasoning of those turns; the visible answers
// stay. Each replacement keeps the record's byte length, so the app-server's
// open append handle and the byte offsets Codex keeps into segments stay
// valid. The app-server still has to restart to reread the thread.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { listRollouts, historyBase, ROLLOUT_NAME_RE } = require("./rollout_repair.cjs");

const ERROR_CODE = "invalid_encrypted_content";
const OPENAI_PROVIDER = "openai";
const BACKUP_SUFFIX = ".bak-before-strip";
const TAIL_BYTES = 16384;
const TAIL_LINES = 3;
const WATCH_DEBOUNCE_MS = 250;
const OPEN_FILES_POLL_MS = 2000;
const MARKER = Buffer.from('"encrypted_content":"');
const REPLACEMENT = Buffer.from('"encrypted_content":null');

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function parseRecord(line) {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
}

function readTail(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function userMessageText(records, turnId) {
  for (const record of records) {
    const payload = record?.payload;
    if (payload?.type !== "item_completed" || payload.turn_id !== turnId || payload.item?.type !== "UserMessage") {
      continue;
    }
    const text = (payload.item.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .replace(/\s+$/, "");
    return text.length > 0 ? text : null;
  }
  return null;
}

// The failed turn when the last lines of a rollout end a turn with the
// encrypted-content error, else null. Carries the message the user sent so
// it can be sent again.
function encryptedContentFailure(file) {
  const records = readTail(file)
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseRecord);
  for (const record of records.slice(-TAIL_LINES).reverse()) {
    const payload = record?.payload;
    if (record?.type !== "event_msg" || payload?.type !== "task_complete") {
      continue;
    }
    const message = payload.error?.message;
    if (typeof message !== "string" || !message.includes(ERROR_CODE)) {
      continue;
    }
    const turnId = payload.turn_id ?? null;
    return {
      turnId,
      itemId: /\brs_[A-Za-z0-9]+/.exec(message)?.[0] ?? null,
      text: userMessageText(records, turnId),
    };
  }
  return null;
}

function rolloutOf(file) {
  const match = ROLLOUT_NAME_RE.exec(path.basename(file));
  return match == null ? null : { file, threadId: match[1], segmentId: match[2] ?? match[1] };
}

// The thread's segments from its first to the given one. Every segment but
// the last only contributes the records before the point where the next
// segment branched off.
function segmentChain(file, home, log) {
  const segments = new Map(listRollouts(home).map((rollout) => [rollout.segmentId, rollout]));
  const chain = [];
  let current = rolloutOf(file);
  let endByteOffset = null;
  while (current != null) {
    chain.unshift({ ...current, endByteOffset });
    const base = historyBase(current.file);
    if (base == null) {
      break;
    }
    endByteOffset = base.endByteOffset;
    current = segments.get(base.segmentId) ?? null;
    if (current == null) {
      log(`segment ${base.segmentId} of thread ${chain[0].threadId} is missing; earlier turns are left alone`);
    }
  }
  return chain;
}

function encryptedSpan(line, payload) {
  const start = line.indexOf(MARKER);
  if (start === -1) {
    return null;
  }
  const valueStart = start + MARKER.length;
  const valueEnd = line.indexOf(0x22, valueStart);
  if (valueEnd === -1 || valueEnd - valueStart !== Buffer.byteLength(payload.encrypted_content, "utf8")) {
    return null;
  }
  return { start, length: valueEnd + 1 - start };
}

// Finds the reasoning items of one segment that another provider produced,
// plus the item the error named, and blanks them in place.
function stripSegment(segment, { provider, itemId, dryRun, log }) {
  const data = fs.readFileSync(segment.file);
  const limit = segment.endByteOffset ?? data.length;
  const writes = [];
  const stripped = [];
  let producer = OPENAI_PROVIDER;
  let lineStart = 0;
  while (lineStart < limit) {
    const newline = data.indexOf(0x0a, lineStart);
    const lineEnd = newline === -1 ? data.length : newline;
    const line = data.subarray(lineStart, lineEnd);
    const record = parseRecord(line);
    const payload = record?.payload;
    if (record?.type === "session_meta") {
      producer = payload?.model_provider ?? OPENAI_PROVIDER;
    } else if (payload?.type === "thread_settings_applied" && payload.thread_settings?.model_provider_id) {
      producer = payload.thread_settings.model_provider_id;
    } else if (
      record?.type === "response_item" &&
      payload?.type === "reasoning" &&
      typeof payload.encrypted_content === "string" &&
      payload.encrypted_content.length > 0 &&
      (producer !== provider || payload.id === itemId)
    ) {
      const span = encryptedSpan(line, payload);
      if (span == null) {
        log(`cannot locate the encrypted content of ${payload.id} in ${path.basename(segment.file)}`);
      } else {
        const replacement = Buffer.alloc(span.length, 0x20);
        REPLACEMENT.copy(replacement);
        writes.push({ position: lineStart + span.start, replacement });
        stripped.push({ itemId: payload.id, producer, segment: path.basename(segment.file) });
      }
    }
    lineStart = lineEnd + 1;
  }
  if (writes.length === 0 || dryRun) {
    return stripped;
  }
  backupOnce(segment.file);
  const fd = fs.openSync(segment.file, "r+");
  try {
    for (const write of writes) {
      fs.writeSync(fd, write.replacement, 0, write.replacement.length, write.position);
    }
  } finally {
    fs.closeSync(fd);
  }
  return stripped;
}

// Blanks, across the whole thread that ends in the given segment, the
// encrypted reasoning that providers other than `provider` produced.
// Returns the blanked items.
function stripForeignReasoning({ file, provider, itemId = null, home = codexHome(), dryRun = false, log = () => {} }) {
  const stripped = [];
  for (const segment of segmentChain(file, home, log)) {
    stripped.push(...stripSegment(segment, { provider, itemId, dryRun, log }));
  }
  for (const item of stripped) {
    log(`${dryRun ? "would blank" : "blanked"} reasoning ${item.itemId} from ${item.producer} in ${item.segment}`);
  }
  return stripped;
}

function backupOnce(file) {
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }
}

// The rollouts a process appends to, read from the files it holds open.
function openRollouts(pids) {
  return new Promise((resolve) => {
    if (pids.length === 0) {
      resolve([]);
      return;
    }
    execFile("/usr/sbin/lsof", ["-p", pids.join(","), "-Fn"], { encoding: "utf8" }, (_error, stdout) => {
      const files = (stdout ?? "")
        .split("\n")
        .filter((line) => line.startsWith("n/"))
        .map((line) => line.slice(1))
        .filter((file) => ROLLOUT_NAME_RE.test(path.basename(file)));
      resolve([...new Set(files)]);
    });
  });
}

// Reports each turn that ends with the encrypted-content error while the
// watch runs; the same turn is reported once, and a failure that already
// ended a rollout when the watch started is left alone, since the user has
// moved on from it. Watches sit on the files the app-server holds open,
// because a watch on the directory tree never sees the appends to a file
// that stays open. A file found later is checked as soon as it is found,
// since the app-server may open a thread and fail its turn between two
// polls.
function watchOpenRollouts({ pids, onFailure, log = () => {}, intervalMs = OPEN_FILES_POLL_MS }) {
  const watches = new Map();
  const reported = new Map();
  const timers = new Map();
  const check = (file, { report = true } = {}) => {
    let failure;
    try {
      failure = encryptedContentFailure(file);
    } catch {
      return;
    }
    if (failure == null || reported.get(file) === failure.turnId) {
      return;
    }
    reported.set(file, failure.turnId);
    if (report) {
      onFailure({ file, threadId: rolloutOf(file).threadId, ...failure });
    }
  };
  const schedule = (file) => {
    clearTimeout(timers.get(file));
    timers.set(
      file,
      setTimeout(() => {
        timers.delete(file);
        check(file);
      }, WATCH_DEBOUNCE_MS),
    );
  };
  const unwatch = (file) => {
    watches.get(file)?.close();
    watches.delete(file);
    clearTimeout(timers.get(file));
    timers.delete(file);
  };
  let polling = false;
  let started = false;
  const poll = async () => {
    if (polling) {
      return;
    }
    polling = true;
    try {
      const open = new Set(await openRollouts(pids()));
      for (const file of watches.keys()) {
        if (!open.has(file)) {
          unwatch(file);
        }
      }
      for (const file of open) {
        if (watches.has(file)) {
          continue;
        }
        try {
          const watcher = fs.watch(file, () => schedule(file));
          watcher.on("error", () => unwatch(file));
          watches.set(file, watcher);
        } catch (error) {
          log(`cannot watch ${path.basename(file)}: ${error.message}`);
          continue;
        }
        check(file, { report: started });
      }
      started = true;
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => void poll(), intervalMs);
  void poll();
  return () => {
    clearInterval(timer);
    for (const file of [...watches.keys()]) {
      unwatch(file);
    }
  };
}

function latestSegment(threadId, home) {
  const segments = listRollouts(home).filter((rollout) => rollout.threadId === threadId);
  const bases = new Set(segments.map((segment) => historyBase(segment.file)?.segmentId));
  let latest = null;
  for (const segment of segments) {
    if (bases.has(segment.segmentId)) {
      continue;
    }
    const modified = fs.statSync(segment.file).mtimeMs;
    if (latest == null || modified > latest.modified) {
      latest = { ...segment, modified };
    }
  }
  return latest;
}

module.exports = {
  encryptedContentFailure,
  stripForeignReasoning,
  watchOpenRollouts,
  latestSegment,
  ERROR_CODE,
  BACKUP_SUFFIX,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const threadId = option("--thread");
  if (threadId == null) {
    console.error("usage: node scripts/encrypted_reasoning.cjs --thread <thread id> [--provider <provider id>] [--dry-run]");
    process.exit(2);
  }
  const home = codexHome();
  const segment = latestSegment(threadId, home);
  if (segment == null) {
    console.error(`no rollout found for thread ${threadId}`);
    process.exit(1);
  }
  const provider =
    option("--provider") ??
    require("./profile_switcher.cjs").activeProvider(fs.readFileSync(path.join(home, "config.toml"), "utf8"));
  const stripped = stripForeignReasoning({
    file: segment.file,
    provider,
    home,
    dryRun: args.includes("--dry-run"),
    log: (message) => console.log(message),
  });
  console.log(
    stripped.length === 0
      ? `no reasoning from other providers than ${provider} in thread ${threadId}`
      : `${stripped.length} item(s); start or restart Codex so the thread is read again`,
  );
}

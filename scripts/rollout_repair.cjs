"use strict";

// Repairs rollout segments whose ordinals stopped increasing. Codex resumes a
// thread in place after it was quit mid-turn and restarts the ordinal counter
// one too low; its paginated history reader then stops at the duplicate and
// every later turn is hidden from the transcript although it is on disk.
// Renumbering the tail makes those turns visible again. Must only run while
// Codex is not running, because the app-server appends to these files.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MARKER_NAME = ".codex-mod-rollout-repair.json";
const BACKUP_SUFFIX = ".bak-before-renumber";
const FIRST_SCAN_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RESCAN_SLACK_MS = 60 * 1000;
const ROLLOUT_NAME_RE = /^rollout-.*-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl$/;
const ORDINAL_RE = /^\{"timestamp":"([^"]*)","ordinal":(\d+),/;

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function listRollouts(home) {
  const rollouts = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      const match = ROLLOUT_NAME_RE.exec(entry.name);
      if (match != null) {
        rollouts.push({ file, threadId: match[1], segmentId: match[2] ?? match[1] });
      }
    }
  };
  walk(path.join(home, "sessions"));
  walk(path.join(home, "archived_sessions"));
  return rollouts;
}

function lineOrdinal(line) {
  const match = ORDINAL_RE.exec(line);
  if (match != null) {
    return { timestamp: match[1], ordinal: Number(match[2]), literal: match[2] };
  }
  if (!line.includes('"ordinal"')) {
    return null;
  }
  try {
    const record = JSON.parse(line);
    return typeof record.ordinal === "number"
      ? { timestamp: record.timestamp ?? "", ordinal: record.ordinal, literal: String(record.ordinal) }
      : null;
  } catch {
    return null;
  }
}

// Returns the renumbered text plus the ordinal and byte mappings that
// dependent segments need, or null when the ordinals already increase.
function renumber(text) {
  const lines = text.split("\n");
  const fixes = [];
  const byteShifts = [];
  let previous = null;
  let delta = 0;
  let oldOffset = 0;
  let byteDelta = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const oldLength = Buffer.byteLength(line, "utf8") + 1;
    const parsed = lineOrdinal(line);
    if (parsed != null) {
      let ordinal = parsed.ordinal + delta;
      if (previous != null && ordinal <= previous) {
        fixes.push({ oldOrdinal: parsed.ordinal, newOrdinal: previous + 1, timestamp: parsed.timestamp });
        delta += previous + 1 - ordinal;
        ordinal = previous + 1;
      }
      previous = ordinal;
      if (ordinal !== parsed.ordinal) {
        const marker = `"ordinal":${parsed.literal},`;
        const position = line.indexOf(marker);
        if (position === -1 || line.indexOf(marker, position + 1) !== -1) {
          throw new Error(`ambiguous ordinal field in record ${parsed.timestamp}`);
        }
        const replaced = line.slice(0, position) + `"ordinal":${ordinal},` + line.slice(position + marker.length);
        const change = Buffer.byteLength(replaced, "utf8") + 1 - oldLength;
        if (change !== 0) {
          byteDelta += change;
          byteShifts.push({ oldStart: oldOffset, deltaAfter: byteDelta });
        }
        lines[index] = replaced;
      }
    }
    oldOffset += oldLength;
  }
  if (fixes.length === 0) {
    return null;
  }
  const mapOrdinal = (exclusiveEnd) => {
    let shift = 0;
    for (const fix of fixes) {
      if (fix.oldOrdinal < exclusiveEnd) {
        shift = fix.newOrdinal - fix.oldOrdinal;
      }
    }
    return exclusiveEnd + shift;
  };
  const mapByteOffset = (offset) => {
    let shift = 0;
    for (const entry of byteShifts) {
      if (entry.oldStart < offset) {
        shift = entry.deltaAfter;
      }
    }
    return offset + shift;
  };
  return { text: lines.join("\n"), fixes, mapOrdinal, mapByteOffset, bytesChanged: byteShifts.length > 0 };
}

function historyBase(file) {
  const head = fs.readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 65536);
  const firstLine = head.slice(0, head.indexOf("\n"));
  const match = /"history_base":\{"thread_id":"([0-9a-f-]{36})","end_ordinal_exclusive":(\d+),"end_byte_offset":(\d+)\}/.exec(firstLine);
  return match == null
    ? null
    : { segmentId: match[1], endOrdinal: Number(match[2]), endByteOffset: Number(match[3]), firstLine };
}

function writeAtomically(file, text) {
  const backup = file + BACKUP_SUFFIX;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(file, backup);
  }
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

// Segments that continue from a renumbered one record where they branched
// off; those references move with the renumbering.
function updateDependents(rollout, mapping, rollouts, log) {
  const updated = [];
  for (const candidate of rollouts) {
    if (candidate.threadId !== rollout.threadId || candidate.file === rollout.file) {
      continue;
    }
    const base = historyBase(candidate.file);
    if (base == null || base.segmentId !== rollout.segmentId) {
      continue;
    }
    const endOrdinal = mapping.mapOrdinal(base.endOrdinal);
    const endByteOffset = mapping.mapByteOffset(base.endByteOffset);
    if (endOrdinal === base.endOrdinal && endByteOffset === base.endByteOffset) {
      continue;
    }
    const text = fs.readFileSync(candidate.file, "utf8");
    const newFirstLine = base.firstLine.replace(
      `"end_ordinal_exclusive":${base.endOrdinal},"end_byte_offset":${base.endByteOffset}}`,
      `"end_ordinal_exclusive":${endOrdinal},"end_byte_offset":${endByteOffset}}`,
    );
    writeAtomically(candidate.file, newFirstLine + text.slice(base.firstLine.length));
    log(`updated history base of ${path.basename(candidate.file)}`);
    updated.push(candidate);
    const shift = Buffer.byteLength(newFirstLine, "utf8") - Buffer.byteLength(base.firstLine, "utf8");
    if (shift !== 0) {
      const firstLineLength = Buffer.byteLength(base.firstLine, "utf8");
      updated.push(
        ...updateDependents(
          candidate,
          {
            mapOrdinal: (value) => value,
            mapByteOffset: (offset) => (offset > firstLineLength ? offset + shift : offset),
          },
          rollouts,
          log,
        ),
      );
    }
  }
  return updated;
}

function repairRollout(rollout, rollouts, { dryRun, log }) {
  const text = fs.readFileSync(rollout.file, "utf8");
  const mapping = renumber(text);
  if (mapping == null) {
    return null;
  }
  const name = path.basename(rollout.file);
  const summary = mapping.fixes
    .map((fix) => `${fix.oldOrdinal}->${fix.newOrdinal} at ${fix.timestamp}`)
    .join(", ");
  if (rollout.segmentId === rollout.threadId && mapping.bytesChanged) {
    // Codex keeps byte offsets into a thread's first segment in its history
    // projection; moving those bytes would corrupt it.
    log(`skipping ${name}: renumbering would move bytes in a thread's first segment (${summary})`);
    return null;
  }
  if (dryRun) {
    log(`would repair ${name}: ${summary}`);
    return { rollout, fixes: mapping.fixes, dependents: [] };
  }
  writeAtomically(rollout.file, mapping.text);
  log(`repaired ${name}: ${summary}; backup kept as ${name}${BACKUP_SUFFIX}`);
  const dependents = updateDependents(rollout, mapping, rollouts, log);
  return { rollout, fixes: mapping.fixes, dependents };
}

function readMarker(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, MARKER_NAME), "utf8"));
  } catch {
    return {};
  }
}

// Scans rollouts modified since the previous scan and repairs every segment
// whose ordinals regress. Returns the repairs made.
function repairRollouts({ home = codexHome(), all = false, dryRun = false, log = () => {} } = {}) {
  const marker = readMarker(home);
  const scanStart = Date.now();
  const since = all ? 0 : (marker.scannedAt ?? scanStart - FIRST_SCAN_WINDOW_MS) - RESCAN_SLACK_MS;
  const rollouts = listRollouts(home);
  const repairs = [];
  for (const rollout of rollouts) {
    let modified;
    try {
      modified = fs.statSync(rollout.file).mtimeMs;
    } catch {
      continue;
    }
    if (modified < since) {
      continue;
    }
    try {
      const repair = repairRollout(rollout, rollouts, { dryRun, log });
      if (repair != null) {
        repairs.push(repair);
      }
    } catch (error) {
      log(`could not repair ${path.basename(rollout.file)}: ${error.message}`);
    }
  }
  if (!dryRun) {
    fs.writeFileSync(path.join(home, MARKER_NAME), JSON.stringify({ scannedAt: scanStart }));
  }
  return repairs;
}

module.exports = { repairRollouts, renumber, listRollouts, historyBase, BACKUP_SUFFIX, ROLLOUT_NAME_RE };

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const repairs = repairRollouts({
    all: args.has("--all"),
    dryRun,
    log: (message) => console.log(message),
  });
  if (repairs.length === 0) {
    console.log("no rollout needs repair");
  } else if (!dryRun) {
    console.log(`${repairs.length} rollout(s) repaired; start Codex to see the restored turns`);
  }
}

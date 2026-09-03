import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createPackageFromStreams, getRawHeader } from "@electron/asar";

const [sourceAsar, extractedRoot, destinationAsar] = process.argv
  .slice(2)
  .map((argument) => (argument ? path.resolve(argument) : argument));

if (!sourceAsar || !extractedRoot || !destinationAsar) {
  throw new Error(
    "usage: pack-preserving-unpacked.mjs <source.asar> <extracted-dir> <destination.asar>",
  );
}

const originalHeader = getRawHeader(sourceAsar).header;
const streams = [];

function orderedNames(directory, headerEntry) {
  const diskNames = new Set(fs.readdirSync(directory));
  const headerNames = Object.keys(headerEntry?.files ?? {});
  const missingNames = headerNames.filter((name) => !diskNames.has(name));

  if (missingNames.length > 0) {
    throw new Error(
      `extracted archive is missing ${path.join(directory, missingNames[0])}`,
    );
  }

  const newNames = [...diskNames]
    .filter((name) => !Object.hasOwn(headerEntry?.files ?? {}, name))
    .sort();
  return [...headerNames, ...newNames];
}

function addDirectory(directory, archivePath, headerEntry) {
  for (const name of orderedNames(directory, headerEntry)) {
    const absolutePath = path.join(directory, name);
    const relativePath = archivePath ? path.join(archivePath, name) : name;
    const childHeader = headerEntry?.files?.[name];
    const stat = fs.lstatSync(absolutePath);
    const unpacked = childHeader?.unpacked === true;

    if (stat.isDirectory()) {
      streams.push({ path: relativePath, type: "directory", unpacked });
      addDirectory(absolutePath, relativePath, childHeader);
      continue;
    }

    if (stat.isSymbolicLink()) {
      streams.push({
        path: relativePath,
        type: "link",
        unpacked,
        stat,
        streamGenerator: () => fs.createReadStream(absolutePath),
        symlink: fs.readlinkSync(absolutePath),
      });
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`unsupported archive entry: ${absolutePath}`);
    }

    streams.push({
      path: relativePath,
      type: "file",
      unpacked,
      stat,
      streamGenerator: () => fs.createReadStream(absolutePath),
    });
  }
}

// Electron aborts the app when a file's bytes differ from the integrity
// recorded in the header, so every entry is checked against the archive that
// is about to be installed.
function verifyIntegrity(archivePath) {
  const raw = getRawHeader(archivePath);
  const contentOffset = 8 + raw.headerSize;
  const descriptor = fs.openSync(archivePath, "r");
  const mismatches = [];

  function walk(entry, prefix) {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const entryPath = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        walk(child, entryPath);
        continue;
      }
      if (child.link || !child.integrity) {
        continue;
      }
      let bytes;
      if (child.unpacked) {
        bytes = fs.readFileSync(path.join(`${archivePath}.unpacked`, entryPath));
      } else {
        bytes = Buffer.alloc(Number(child.size));
        fs.readSync(descriptor, bytes, 0, bytes.length, contentOffset + Number(child.offset));
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== child.integrity.hash) {
        mismatches.push(entryPath);
      }
    }
  }

  try {
    walk(raw.header, "");
  } finally {
    fs.closeSync(descriptor);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `packed archive integrity does not match its contents: ${mismatches.join(", ")}`,
    );
  }
}

addDirectory(extractedRoot, "", originalHeader);
// @electron/asar hashes small files by reading their archive-relative path
// from the working directory, so packing has to run from the extracted root
// or the header records the hash of an unrelated file.
process.chdir(extractedRoot);
await createPackageFromStreams(destinationAsar, streams);
verifyIntegrity(destinationAsar);

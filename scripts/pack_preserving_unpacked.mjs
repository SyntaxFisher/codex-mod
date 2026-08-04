import fs from "node:fs";
import path from "node:path";

import { createPackageFromStreams, getRawHeader } from "@electron/asar";

const [sourceAsar, extractedRoot, destinationAsar] = process.argv.slice(2);

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

addDirectory(extractedRoot, "", originalHeader);
await createPackageFromStreams(destinationAsar, streams);

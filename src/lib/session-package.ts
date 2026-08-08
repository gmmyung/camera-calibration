import { strFromU8, strToU8, unzip, zip } from "fflate";
import { parseStoredSession } from "../domain/session";
import type { CalibrationSessionV1 } from "../domain/types";
import { getSessionBlob } from "./session-db";

const PACKAGE_FORMAT = "web-camera-calibration-session";
const PACKAGE_VERSION = 1;
const MAX_PACKAGE_BYTES = 350 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 205;

interface PackageBlobEntry {
  key: string;
  path: string;
  type: string;
  size: number;
}

interface SessionPackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  blobs: PackageBlobEntry[];
}

export interface ImportedSessionPackage {
  session: CalibrationSessionV1;
  blobs: Array<readonly [string, Blob]>;
}

function zipArchive(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function unzipArchive(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(data, (error, entries) => {
      if (error) reject(error);
      else resolve(entries);
    });
  });
}

function ownedBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function requiredBlobKeys(session: CalibrationSessionV1): string[] {
  const keys = session.observations.flatMap((observation) => [
    observation.imageBlobKey,
    observation.thumbnailBlobKey,
  ]);
  if (new Set(keys).size !== keys.length) {
    throw new Error("The calibration session contains duplicate image references.");
  }
  return keys;
}

function readUint16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)
  ) >>> 0;
}

function validateArchiveEnvelope(data: Uint8Array): void {
  const minimumOffset = Math.max(0, data.length - 65_557);
  let endOffset = -1;
  for (let offset = data.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readUint32(data, offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("The selected file is not a valid session package.");
  const diskNumber = readUint16(data, endOffset + 4);
  const centralDirectoryDisk = readUint16(data, endOffset + 6);
  const entriesOnDisk = readUint16(data, endOffset + 8);
  const entryCount = readUint16(data, endOffset + 10);
  const centralSize = readUint32(data, endOffset + 12);
  const centralOffset = readUint32(data, endOffset + 16);
  const commentLength = readUint16(data, endOffset + 20);
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount < 2 ||
    entryCount > MAX_ARCHIVE_ENTRIES ||
    centralOffset + centralSize !== endOffset ||
    endOffset + 22 + commentLength !== data.length
  ) {
    throw new Error("The session package contains an invalid archive index.");
  }
  let offset = centralOffset;
  let totalSize = 0;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (readUint32(data, offset) !== 0x02014b50 || offset + 46 > data.length) {
      throw new Error("The session package contains an invalid archive entry.");
    }
    const uncompressedSize = readUint32(data, offset + 24);
    if (uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 session packages are not supported.");
    }
    totalSize += uncompressedSize;
    if (totalSize > MAX_PACKAGE_BYTES) {
      throw new Error("The expanded session package exceeds the 350 MB limit.");
    }
    const nameLength = readUint16(data, offset + 28);
    const extraLength = readUint16(data, offset + 30);
    const commentLength = readUint16(data, offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > centralOffset + centralSize) {
      throw new Error("The session package archive index is truncated.");
    }
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error("The session package archive index has an invalid size.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): SessionPackageManifest {
  if (
    !isRecord(value) ||
    value.format !== PACKAGE_FORMAT ||
    value.version !== PACKAGE_VERSION ||
    !Array.isArray(value.blobs) ||
    value.blobs.length > MAX_ARCHIVE_ENTRIES - 2
  ) {
    throw new Error("The session package manifest is invalid or unsupported.");
  }
  const keys = new Set<string>();
  const paths = new Set<string>();
  const blobs: PackageBlobEntry[] = value.blobs.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      entry.key.length === 0 ||
      entry.key.length > 1_024 ||
      typeof entry.path !== "string" ||
      entry.path !== `blobs/${String(index).padStart(4, "0")}.bin` ||
      typeof entry.type !== "string" ||
      entry.type.length > 200 ||
      !Number.isInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > MAX_PACKAGE_BYTES ||
      keys.has(entry.key) ||
      paths.has(entry.path)
    ) {
      throw new Error("The session package contains invalid blob metadata.");
    }
    keys.add(entry.key);
    paths.add(entry.path);
    return {
      key: entry.key,
      path: entry.path,
      type: entry.type,
      size: entry.size as number,
    };
  });
  return { format: PACKAGE_FORMAT, version: PACKAGE_VERSION, blobs };
}

export async function createSessionPackage(session: CalibrationSessionV1): Promise<Blob> {
  const archiveEntries: Record<string, Uint8Array> = {
    "session.json": strToU8(`${JSON.stringify(session, null, 2)}\n`),
  };
  const manifestEntries: PackageBlobEntry[] = [];
  for (const [index, key] of requiredBlobKeys(session).entries()) {
    const blob = await getSessionBlob(key);
    if (!blob) throw new Error(`Saved image data is missing for ${key}.`);
    const path = `blobs/${String(index).padStart(4, "0")}.bin`;
    archiveEntries[path] = new Uint8Array(await blob.arrayBuffer());
    manifestEntries.push({ key, path, type: blob.type, size: blob.size });
  }
  const manifest: SessionPackageManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    blobs: manifestEntries,
  };
  archiveEntries["manifest.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  const data = await zipArchive(archiveEntries);
  if (data.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error("The session package exceeds the 350 MB limit.");
  }
  return new Blob([ownedBuffer(data)], { type: "application/zip" });
}

export async function readSessionPackage(file: Blob): Promise<ImportedSessionPackage> {
  if (file.size <= 0 || file.size > MAX_PACKAGE_BYTES) {
    throw new Error("The session package must be no larger than 350 MB.");
  }
  const data = new Uint8Array(await file.arrayBuffer());
  validateArchiveEnvelope(data);
  const archive = await unzipArchive(data);
  const manifestBytes = archive["manifest.json"];
  const sessionBytes = archive["session.json"];
  if (!manifestBytes || !sessionBytes) {
    throw new Error("The session package is missing its manifest or session metadata.");
  }
  let manifestValue: unknown;
  let sessionValue: unknown;
  try {
    manifestValue = JSON.parse(strFromU8(manifestBytes));
    sessionValue = JSON.parse(strFromU8(sessionBytes));
  } catch {
    throw new Error("The session package metadata is not valid JSON.");
  }
  const manifest = parseManifest(manifestValue);
  const session = parseStoredSession(sessionValue);
  if (!session) throw new Error("The session package contains invalid calibration data.");
  const archivePaths = Object.keys(archive);
  const declaredPaths = new Set([
    "manifest.json",
    "session.json",
    ...manifest.blobs.map(({ path }) => path),
  ]);
  if (
    archivePaths.length !== declaredPaths.size ||
    archivePaths.some((path) => !declaredPaths.has(path))
  ) {
    throw new Error("The session package contains undeclared archive entries.");
  }

  const requiredKeys = requiredBlobKeys(session);
  const manifestKeys = new Set(manifest.blobs.map(({ key }) => key));
  if (
    requiredKeys.length !== manifest.blobs.length ||
    requiredKeys.some((key) => !manifestKeys.has(key))
  ) {
    throw new Error("The session package does not match its calibration views.");
  }
  const blobs: Array<readonly [string, Blob]> = manifest.blobs.map((entry) => {
    const contents = archive[entry.path];
    if (!contents || contents.byteLength !== entry.size) {
      throw new Error(`The session package is missing image data for ${entry.key}.`);
    }
    return [entry.key, new Blob([ownedBuffer(contents)], { type: entry.type })] as const;
  });
  return { session, blobs };
}

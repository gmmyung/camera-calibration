import type { CalibrationSessionV1 } from "../domain/types";

const DB_NAME = "lensbench-calibration";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const BLOB_STORE = "blobs";
const ACTIVE_SESSION_KEY = "active";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE);
      }
      if (!database.objectStoreNames.contains(BLOB_STORE)) {
        database.createObjectStore(BLOB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open local storage."));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Local storage failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Local storage was aborted."));
  });
}

export async function saveActiveSession(session: CalibrationSessionV1): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).put(session, ACTIVE_SESSION_KEY);
  await transactionComplete(transaction);
  database.close();
}

export async function loadActiveSession(): Promise<CalibrationSessionV1 | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const request = transaction.objectStore(SESSION_STORE).get(ACTIVE_SESSION_KEY);
  const result = await new Promise<CalibrationSessionV1 | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as CalibrationSessionV1 | undefined);
    request.onerror = () => reject(request.error ?? new Error("Unable to restore the session."));
  });
  database.close();
  return result;
}

export async function putSessionBlob(key: string, blob: Blob): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(BLOB_STORE, "readwrite");
  transaction.objectStore(BLOB_STORE).put(blob, key);
  await transactionComplete(transaction);
  database.close();
}

export async function getSessionBlob(key: string): Promise<Blob | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(BLOB_STORE, "readonly");
  const request = transaction.objectStore(BLOB_STORE).get(key);
  const result = await new Promise<Blob | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error ?? new Error("Unable to read a saved image."));
  });
  database.close();
  return result;
}

export async function deleteSessionBlob(key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(BLOB_STORE, "readwrite");
  transaction.objectStore(BLOB_STORE).delete(key);
  await transactionComplete(transaction);
  database.close();
}

export async function clearLocalSession(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SESSION_STORE, BLOB_STORE], "readwrite");
  transaction.objectStore(SESSION_STORE).clear();
  transaction.objectStore(BLOB_STORE).clear();
  await transactionComplete(transaction);
  database.close();
}

export async function storageHeadroom(): Promise<{ remaining?: number; quota?: number }> {
  if (!navigator.storage?.estimate) return {};
  const estimate = await navigator.storage.estimate();
  return {
    quota: estimate.quota,
    remaining:
      estimate.quota !== undefined && estimate.usage !== undefined
        ? estimate.quota - estimate.usage
        : undefined,
  };
}

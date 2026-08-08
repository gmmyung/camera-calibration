import type { CalibrationSessionV1 } from "../domain/types";

const DB_NAME = "camera-calibration";
const LEGACY_DB_NAME = ["lens", "bench-calibration"].join("");
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const BLOB_STORE = "blobs";
const ACTIVE_SESSION_KEY = "active";

function openDatabase(databaseName = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(databaseName, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE);
      }
      if (!database.objectStoreNames.contains(BLOB_STORE)) {
        database.createObjectStore(BLOB_STORE);
      }
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open local storage."));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Local storage is blocked by another open calibration tool tab."));
    };
  });
}

function requestResult<T>(request: IDBRequest<T>, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(message));
  });
}

function deleteDatabase(databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Unable to remove old local storage."));
    request.onblocked = () => reject(new Error("Old local storage is open in another tab."));
  });
}

async function migrateLegacyDatabase(): Promise<boolean> {
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    if (!databases.some(({ name }) => name === LEGACY_DB_NAME)) return false;
  }

  const legacy = await openDatabase(LEGACY_DB_NAME);
  let session: unknown;
  let keys: IDBValidKey[] = [];
  let blobs: unknown[] = [];
  try {
    const transaction = legacy.transaction([SESSION_STORE, BLOB_STORE], "readonly");
    const completion = transactionComplete(transaction);
    const sessionRequest = transaction.objectStore(SESSION_STORE).get(ACTIVE_SESSION_KEY);
    const blobStore = transaction.objectStore(BLOB_STORE);
    [session, keys, blobs] = await Promise.all([
      requestResult(sessionRequest, "Unable to read the old saved session."),
      requestResult(blobStore.getAllKeys(), "Unable to read old image keys."),
      requestResult(blobStore.getAll(), "Unable to read old saved images."),
    ]);
    await completion;
  } finally {
    legacy.close();
  }

  if (session !== undefined || keys.length > 0) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction([SESSION_STORE, BLOB_STORE], "readwrite");
      if (session !== undefined) {
        transaction.objectStore(SESSION_STORE).put(session, ACTIVE_SESSION_KEY);
      }
      const blobStore = transaction.objectStore(BLOB_STORE);
      keys.forEach((key, index) => {
        const blob = blobs[index];
        if (blob !== undefined) blobStore.put(blob, key);
      });
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }
  await deleteDatabase(LEGACY_DB_NAME).catch(() => undefined);
  return session !== undefined;
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
  try {
    const transaction = database.transaction(SESSION_STORE, "readwrite");
    transaction.objectStore(SESSION_STORE).put(session, ACTIVE_SESSION_KEY);
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function loadActiveSession(): Promise<unknown> {
  const readCurrent = async (): Promise<unknown> => {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(SESSION_STORE, "readonly");
      return await requestResult(
        transaction.objectStore(SESSION_STORE).get(ACTIVE_SESSION_KEY),
        "Unable to restore the session.",
      );
    } finally {
      database.close();
    }
  };
  const current = await readCurrent();
  if (current !== undefined) return current;
  return (await migrateLegacyDatabase()) ? readCurrent() : undefined;
}

export async function putSessionBlob(key: string, blob: Blob): Promise<void> {
  await putSessionBlobs([[key, blob]]);
}

export async function putSessionBlobs(entries: ReadonlyArray<readonly [string, Blob]>): Promise<void> {
  if (entries.length === 0) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(BLOB_STORE, "readwrite");
    const store = transaction.objectStore(BLOB_STORE);
    try {
      entries.forEach(([key, blob]) => store.put(blob, key));
    } catch (error) {
      transaction.abort();
      throw error;
    }
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function replaceLocalSession(
  session: CalibrationSessionV1,
  entries: ReadonlyArray<readonly [string, Blob]>,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([SESSION_STORE, BLOB_STORE], "readwrite");
    const completion = transactionComplete(transaction);
    try {
      const sessionStore = transaction.objectStore(SESSION_STORE);
      const blobStore = transaction.objectStore(BLOB_STORE);
      sessionStore.clear();
      blobStore.clear();
      sessionStore.put(session, ACTIVE_SESSION_KEY);
      entries.forEach(([key, blob]) => blobStore.put(blob, key));
    } catch (error) {
      transaction.abort();
      await completion.catch(() => undefined);
      throw error;
    }
    await completion;
  } finally {
    database.close();
  }
}

export async function getSessionBlob(key: string): Promise<Blob | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(BLOB_STORE, "readonly");
    const request = transaction.objectStore(BLOB_STORE).get(key);
    return await new Promise<Blob | undefined>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as Blob | undefined);
      request.onerror = () => reject(request.error ?? new Error("Unable to read a saved image."));
    });
  } finally {
    database.close();
  }
}

export async function deleteSessionBlob(key: string): Promise<void> {
  await deleteSessionBlobs([key]);
}

export async function deleteSessionBlobs(keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const database = await openDatabase();
  try {
    const transaction = database.transaction(BLOB_STORE, "readwrite");
    const store = transaction.objectStore(BLOB_STORE);
    keys.forEach((key) => store.delete(key));
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
}

export async function clearLocalSession(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction([SESSION_STORE, BLOB_STORE], "readwrite");
    transaction.objectStore(SESSION_STORE).clear();
    transaction.objectStore(BLOB_STORE).clear();
    await transactionComplete(transaction);
  } finally {
    database.close();
  }
  await deleteDatabase(LEGACY_DB_NAME).catch(() => undefined);
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

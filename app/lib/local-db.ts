import type { DBSchema, IDBPDatabase } from "idb";

import {
  DEFAULT_SHOTLAB_SETTINGS,
  type ShotLabSettings,
  type ShotRecord,
  type ShotSyncState,
  type ShotSyncStatus,
  type StoredVideoRecord,
  type VideoUploadStatus,
} from "./types";

const DATABASE_NAME = "shotlab";
const DATABASE_VERSION = 1;
const SETTINGS_KEY = "app" as const;

interface StoredSettings {
  key: typeof SETTINGS_KEY;
  value: ShotLabSettings;
}

interface ShotLabDatabase extends DBSchema {
  shots: {
    key: string;
    value: ShotRecord;
    indexes: {
      "by-owner": string;
      "by-recorded-at": string;
      "by-sync-status": ShotSyncStatus;
    };
  };
  settings: {
    key: typeof SETTINGS_KEY;
    value: StoredSettings;
  };
  videos: {
    key: string;
    value: StoredVideoRecord;
    indexes: {
      "by-shot": string;
      "by-owner": string;
      "by-upload-status": VideoUploadStatus;
    };
  };
}

export interface ShotListOptions {
  ownerId?: string;
  syncStatus?: ShotSyncStatus;
  newestFirst?: boolean;
  limit?: number;
}

export interface VideoListOptions {
  ownerId?: string;
  shotId?: string;
  uploadStatus?: VideoUploadStatus;
  newestFirst?: boolean;
}

export type ShotUpdate = Partial<
  Omit<ShotRecord, "schemaVersion" | "id" | "ownerId" | "createdAt">
>;

export type SettingsUpdate = Partial<
  Omit<ShotLabSettings, "schemaVersion" | "updatedAt">
>;

export type VideoUpdate = Partial<
  Omit<StoredVideoRecord, "id" | "shotId" | "ownerId" | "createdAt">
>;

export class LocalDatabaseUnavailableError extends Error {
  readonly code = "local-db/unavailable";

  constructor() {
    super("ShotLab local storage is only available in a browser with IndexedDB.");
    this.name = "LocalDatabaseUnavailableError";
  }
}

let databasePromise: Promise<IDBPDatabase<ShotLabDatabase>> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function createLocalId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function assertNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
}

export function isLocalDatabaseAvailable(): boolean {
  return typeof window !== "undefined" && "indexedDB" in globalThis;
}

async function openLocalDatabase(): Promise<IDBPDatabase<ShotLabDatabase>> {
  if (!isLocalDatabaseAvailable()) {
    throw new LocalDatabaseUnavailableError();
  }

  const { openDB } = await import("idb");

  return openDB<ShotLabDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains("shots")) {
        const shots = database.createObjectStore("shots", { keyPath: "id" });
        shots.createIndex("by-owner", "ownerId");
        shots.createIndex("by-recorded-at", "recordedAt");
        shots.createIndex("by-sync-status", "sync.status");
      }

      if (!database.objectStoreNames.contains("settings")) {
        database.createObjectStore("settings", { keyPath: "key" });
      }

      if (!database.objectStoreNames.contains("videos")) {
        const videos = database.createObjectStore("videos", { keyPath: "id" });
        videos.createIndex("by-shot", "shotId");
        videos.createIndex("by-owner", "ownerId");
        videos.createIndex("by-upload-status", "uploadStatus");
      }
    },
    blocking() {
      databasePromise?.then((database) => database.close()).catch(() => {});
      databasePromise = null;
    },
    terminated() {
      databasePromise = null;
    },
  });
}

export function getLocalDatabase(): Promise<IDBPDatabase<ShotLabDatabase>> {
  if (!databasePromise) {
    databasePromise = openLocalDatabase().catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

export async function closeLocalDatabase(): Promise<void> {
  if (!databasePromise) return;

  const database = await databasePromise;
  database.close();
  databasePromise = null;
}

export async function saveShot(shot: ShotRecord): Promise<ShotRecord> {
  assertNonEmpty(shot.id, "shot.id");
  assertNonEmpty(shot.ownerId, "shot.ownerId");

  const database = await getLocalDatabase();
  await database.put("shots", shot);
  return shot;
}

export async function saveShots(shots: readonly ShotRecord[]): Promise<void> {
  const database = await getLocalDatabase();
  const transaction = database.transaction("shots", "readwrite");

  for (const shot of shots) {
    assertNonEmpty(shot.id, "shot.id");
    assertNonEmpty(shot.ownerId, "shot.ownerId");
    await transaction.store.put(shot);
  }

  await transaction.done;
}

export async function getShot(shotId: string): Promise<ShotRecord | undefined> {
  const database = await getLocalDatabase();
  return database.get("shots", shotId);
}

export async function listShots(
  options: ShotListOptions = {},
): Promise<ShotRecord[]> {
  const database = await getLocalDatabase();
  let shots: ShotRecord[];

  if (options.ownerId) {
    shots = await database.getAllFromIndex("shots", "by-owner", options.ownerId);
  } else if (options.syncStatus) {
    shots = await database.getAllFromIndex(
      "shots",
      "by-sync-status",
      options.syncStatus,
    );
  } else {
    shots = await database.getAll("shots");
  }

  if (options.ownerId && options.syncStatus) {
    shots = shots.filter((shot) => shot.sync.status === options.syncStatus);
  }

  shots.sort((left, right) =>
    options.newestFirst === false
      ? left.recordedAt.localeCompare(right.recordedAt)
      : right.recordedAt.localeCompare(left.recordedAt),
  );

  return options.limit === undefined
    ? shots
    : shots.slice(0, Math.max(0, options.limit));
}

export async function updateShot(
  shotId: string,
  update: ShotUpdate | ((current: ShotRecord) => ShotRecord),
): Promise<ShotRecord> {
  const database = await getLocalDatabase();
  const transaction = database.transaction("shots", "readwrite");
  const current = await transaction.store.get(shotId);

  if (!current) {
    throw new Error(`Shot ${shotId} was not found in local storage.`);
  }

  const next =
    typeof update === "function"
      ? update(current)
      : { ...current, ...update, updatedAt: update.updatedAt ?? nowIso() };

  if (next.id !== current.id || next.ownerId !== current.ownerId) {
    throw new TypeError("A shot update cannot change its id or ownerId.");
  }

  await transaction.store.put(next);
  await transaction.done;
  return next;
}

export async function setShotSyncState(
  shotId: string,
  status: ShotSyncStatus,
  details: Partial<Omit<ShotSyncState, "status" | "changedAt">> = {},
): Promise<ShotRecord> {
  return updateShot(shotId, (current) => ({
    ...current,
    updatedAt: nowIso(),
    sync: {
      ...current.sync,
      ...details,
      status,
      changedAt: nowIso(),
      error: status === "error" ? details.error : undefined,
    },
  }));
}

export async function deleteShot(
  shotId: string,
  options: { deleteLocalVideos?: boolean } = {},
): Promise<void> {
  const database = await getLocalDatabase();
  const transaction = database.transaction(["shots", "videos"], "readwrite");

  await transaction.objectStore("shots").delete(shotId);

  if (options.deleteLocalVideos !== false) {
    const videoStore = transaction.objectStore("videos");
    const videoKeys = await videoStore.index("by-shot").getAllKeys(shotId);
    for (const videoKey of videoKeys) {
      await videoStore.delete(videoKey);
    }
  }

  await transaction.done;
}

export async function getSettings(): Promise<ShotLabSettings> {
  const database = await getLocalDatabase();
  const stored = await database.get("settings", SETTINGS_KEY);

  return {
    ...DEFAULT_SHOTLAB_SETTINGS,
    ...stored?.value,
  };
}

export async function saveSettings(
  settings: ShotLabSettings,
): Promise<ShotLabSettings> {
  const database = await getLocalDatabase();
  const value: ShotLabSettings = {
    ...DEFAULT_SHOTLAB_SETTINGS,
    ...settings,
    updatedAt: nowIso(),
  };

  await database.put("settings", { key: SETTINGS_KEY, value });
  return value;
}

export async function updateSettings(
  update: SettingsUpdate,
): Promise<ShotLabSettings> {
  const current = await getSettings();
  return saveSettings({ ...current, ...update });
}

export async function resetSettings(): Promise<ShotLabSettings> {
  const database = await getLocalDatabase();
  await database.delete("settings", SETTINGS_KEY);
  return { ...DEFAULT_SHOTLAB_SETTINGS };
}

export async function saveVideo(
  video: StoredVideoRecord,
): Promise<StoredVideoRecord> {
  assertNonEmpty(video.id, "video.id");
  assertNonEmpty(video.shotId, "video.shotId");
  assertNonEmpty(video.ownerId, "video.ownerId");

  const normalized: StoredVideoRecord = {
    ...video,
    contentType: video.contentType || video.blob.type || "video/mp4",
    sizeBytes: video.blob.size,
  };
  const database = await getLocalDatabase();
  await database.put("videos", normalized);
  return normalized;
}

export async function storeVideoForShot(input: {
  id?: string;
  shotId: string;
  ownerId: string;
  blob: Blob;
  originalFileName?: string;
}): Promise<StoredVideoRecord> {
  const timestamp = nowIso();
  const video: StoredVideoRecord = {
    id: input.id ?? createLocalId("video"),
    shotId: input.shotId,
    ownerId: input.ownerId,
    blob: input.blob,
    originalFileName: input.originalFileName ?? `${input.shotId}.mp4`,
    contentType: input.blob.type || "video/mp4",
    sizeBytes: input.blob.size,
    createdAt: timestamp,
    updatedAt: timestamp,
    uploadStatus: "local",
    uploadedBytes: 0,
  };

  return saveVideo(video);
}

export async function getVideo(
  videoId: string,
): Promise<StoredVideoRecord | undefined> {
  const database = await getLocalDatabase();
  return database.get("videos", videoId);
}

export async function getVideosForShot(
  shotId: string,
): Promise<StoredVideoRecord[]> {
  const database = await getLocalDatabase();
  return database.getAllFromIndex("videos", "by-shot", shotId);
}

export async function listVideos(
  options: VideoListOptions = {},
): Promise<StoredVideoRecord[]> {
  const database = await getLocalDatabase();
  let videos: StoredVideoRecord[];

  if (options.shotId) {
    videos = await database.getAllFromIndex("videos", "by-shot", options.shotId);
  } else if (options.ownerId) {
    videos = await database.getAllFromIndex("videos", "by-owner", options.ownerId);
  } else if (options.uploadStatus) {
    videos = await database.getAllFromIndex(
      "videos",
      "by-upload-status",
      options.uploadStatus,
    );
  } else {
    videos = await database.getAll("videos");
  }

  if (options.ownerId) {
    videos = videos.filter((video) => video.ownerId === options.ownerId);
  }
  if (options.shotId) {
    videos = videos.filter((video) => video.shotId === options.shotId);
  }
  if (options.uploadStatus) {
    videos = videos.filter(
      (video) => video.uploadStatus === options.uploadStatus,
    );
  }

  videos.sort((left, right) =>
    options.newestFirst === false
      ? left.createdAt.localeCompare(right.createdAt)
      : right.createdAt.localeCompare(left.createdAt),
  );

  return videos;
}

export async function updateVideo(
  videoId: string,
  update: VideoUpdate,
): Promise<StoredVideoRecord> {
  const database = await getLocalDatabase();
  const transaction = database.transaction("videos", "readwrite");
  const current = await transaction.store.get(videoId);

  if (!current) {
    throw new Error(`Video ${videoId} was not found in local storage.`);
  }

  const next: StoredVideoRecord = {
    ...current,
    ...update,
    sizeBytes: update.blob?.size ?? current.sizeBytes,
    contentType:
      update.contentType || update.blob?.type || current.contentType,
    updatedAt: update.updatedAt ?? nowIso(),
  };

  await transaction.store.put(next);
  await transaction.done;
  return next;
}

export async function deleteVideo(videoId: string): Promise<void> {
  const database = await getLocalDatabase();
  await database.delete("videos", videoId);
}

export async function deleteVideosForShot(shotId: string): Promise<void> {
  const database = await getLocalDatabase();
  const transaction = database.transaction("videos", "readwrite");
  const videoKeys = await transaction.store.index("by-shot").getAllKeys(shotId);

  for (const videoKey of videoKeys) {
    await transaction.store.delete(videoKey);
  }

  await transaction.done;
}

/**
 * Moves local-only records after an explicit account-conflict decision. Google
 * account linking normally preserves the UID and does not need this helper.
 */
export async function reassignLocalOwner(
  previousOwnerId: string,
  nextOwnerId: string,
): Promise<void> {
  assertNonEmpty(previousOwnerId, "previousOwnerId");
  assertNonEmpty(nextOwnerId, "nextOwnerId");
  if (previousOwnerId === nextOwnerId) return;

  const database = await getLocalDatabase();
  const transaction = database.transaction(["shots", "videos"], "readwrite");
  const shotStore = transaction.objectStore("shots");
  const videoStore = transaction.objectStore("videos");
  const changedAt = nowIso();

  const shots = await shotStore.index("by-owner").getAll(previousOwnerId);
  for (const shot of shots) {
    await shotStore.put({
      ...shot,
      ownerId: nextOwnerId,
      updatedAt: changedAt,
      sync: {
        status: "pending",
        changedAt,
      },
    });
  }

  const videos = await videoStore.index("by-owner").getAll(previousOwnerId);
  for (const video of videos) {
    await videoStore.put({
      ...video,
      ownerId: nextOwnerId,
      updatedAt: changedAt,
      uploadStatus: "queued",
      uploadedBytes: 0,
      storagePath: undefined,
      downloadUrl: undefined,
      error: undefined,
    });
  }

  await transaction.done;
}

export const localShotStore = {
  save: saveShot,
  saveMany: saveShots,
  get: getShot,
  list: listShots,
  update: updateShot,
  setSyncState: setShotSyncState,
  delete: deleteShot,
};

export const localSettingsStore = {
  get: getSettings,
  save: saveSettings,
  update: updateSettings,
  reset: resetSettings,
};

export const localVideoStore = {
  save: saveVideo,
  storeForShot: storeVideoForShot,
  get: getVideo,
  getForShot: getVideosForShot,
  list: listVideos,
  update: updateVideo,
  delete: deleteVideo,
  deleteForShot: deleteVideosForShot,
};

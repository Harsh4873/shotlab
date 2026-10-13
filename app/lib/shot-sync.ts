import { FirebasePermanentAccountRequiredError, cloudShotStore, cloudVideoStore } from "./firebase";
import {
  acknowledgeShotDeletion,
  listPendingShotDeletions,
  listShots,
  saveShot,
} from "./local-db";
import type { ShotRecord } from "./types";

function isStorageObjectMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "storage/object-not-found",
  );
}

export function videoUploadFailureMessage(error: unknown): string {
  if (error instanceof FirebasePermanentAccountRequiredError) {
    return "The shot is saved. Cloud video upload needs the Google account you signed in with.";
  }
  if (error instanceof RangeError) {
    return "The shot is saved, but this clip is over the 500 MB upload limit. Metrics still sync.";
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (
    offline ||
    code === "storage/retry-limit-exceeded" ||
    code === "storage/canceled" ||
    code === "auth/network-request-failed" ||
    code === "unavailable"
  ) {
    return "The shot is saved. The video upload stopped because the network failed. Metrics still sync.";
  }
  return "The shot is saved, but the original video did not upload. Metrics still sync.";
}

export class PendingUploadError extends Error {
  readonly syncedIds: readonly string[];

  constructor(message: string, syncedIds: readonly string[]) {
    super(message);
    this.name = "PendingUploadError";
    this.syncedIds = syncedIds;
  }
}

export async function flushShotDeletions(
  ownerId: string,
  removeShot = cloudShotStore.delete,
  removeVideo = cloudVideoStore.delete,
): Promise<void> {
  while (true) {
    const pending = await listPendingShotDeletions(ownerId);
    if (!pending.length) return;
    for (const deletion of pending) {
      await removeShot(deletion.id, ownerId);
      if (deletion.storagePath) {
        try {
          await removeVideo(deletion.storagePath);
        } catch (error) {
          if (!isStorageObjectMissing(error)) throw error;
        }
      }
      await acknowledgeShotDeletion(deletion.id);
    }
  }
}

export async function flushPendingShotUploads(
  ownerId: string,
  saveCloud: (shot: ShotRecord) => Promise<ShotRecord> = cloudShotStore.save,
  listPending: typeof listShots = listShots,
  saveLocal: (shot: ShotRecord) => Promise<ShotRecord> = saveShot,
): Promise<string[]> {
  const pending = await listPending({ ownerId, syncStatus: "pending" });
  const syncedIds: string[] = [];
  let failure: unknown;
  for (const shot of pending) {
    if (shot.ownerId !== ownerId || shot.sync.status !== "pending") continue;
    try {
      const synced = await saveCloud(shot);
      if (synced.sync.status !== "synced") {
        throw new Error("Cloud sync did not finish.");
      }
      await saveLocal(synced);
      syncedIds.push(shot.id);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    const message = failure instanceof Error && failure.message
      ? failure.message
      : "Cloud sync did not finish.";
    throw new PendingUploadError(message, syncedIds);
  }
  return syncedIds;
}

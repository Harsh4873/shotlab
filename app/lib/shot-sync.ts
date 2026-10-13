import { cloudShotStore, cloudVideoStore } from "./firebase";
import {
  acknowledgeShotDeletion,
  listPendingShotDeletions,
  listShots,
  saveShot,
} from "./local-db";
import type { ShotRecord } from "./types";

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
        await removeVideo(deletion.storagePath);
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

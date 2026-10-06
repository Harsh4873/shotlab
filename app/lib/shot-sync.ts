import { cloudShotStore, cloudVideoStore } from "./firebase";
import { acknowledgeShotDeletion, listPendingShotDeletions } from "./local-db";

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
      await acknowledgeShotDeletion(deletion.id);
      if (deletion.storagePath) {
        void removeVideo(deletion.storagePath).catch(() => {});
      }
    }
  }
}

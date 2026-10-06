import "fake-indexeddb/auto";
import { deleteDB, openDB } from "idb";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acknowledgeShotDeletion,
  closeLocalDatabase,
  deleteShot,
  getLocalDatabase,
  getShot,
  getVideosForShot,
  listPendingShotDeletions,
  reconcileCloudShots,
  saveShot,
  storeVideoForShot,
} from "../app/lib/local-db";
import { flushShotDeletions } from "../app/lib/shot-sync";
import type { ShotRecord } from "../app/lib/types";
import { shotRecord, syntheticShotFrames } from "./helpers/shot-fixtures";

vi.stubGlobal("window", {});
const owner = "test-user";
const snapshot = (shots: ShotRecord[], fromCache = false, hasPendingWrites = false) => ({ shots, fromCache, hasPendingWrites });
const synced = (id: string): ShotRecord => ({ ...shotRecord(id, "made", {}), sync: { status: "synced", changedAt: "2026-08-10T12:00:00.000Z" } });

beforeEach(async () => {
  const db = await getLocalDatabase();
  const transaction = db.transaction(["shots", "videos", "deletions"], "readwrite");
  await Promise.all((["shots", "videos", "deletions"] as const).map((name) => transaction.objectStore(name).clear()));
  await transaction.done;
});
afterAll(closeLocalDatabase);

describe("cloud history reconciliation", () => {
  it("durably removes remotely deleted synced shots and their clips, while retaining pending and local-only work", async () => {
    await saveShot(synced("removed"));
    await storeVideoForShot({ shotId: "removed", ownerId: owner, blob: new Blob(["clip"]) });
    const pending = { ...synced("pending"), sync: { status: "pending" as const, changedAt: "now" } };
    const local = shotRecord("local", "unknown", {});
    const other = { ...synced("other"), ownerId: "another-user" };
    await Promise.all([saveShot(pending), saveShot(local), saveShot(other)]);
    const result = await reconcileCloudShots(owner, snapshot([]));
    expect(result.map((shot) => shot.id).sort()).toEqual(["local", "other", "pending"]);
    expect(await getShot("removed")).toBeUndefined();
    expect(await getVideosForShot("removed")).toEqual([]);
    await closeLocalDatabase();
    // An old cached document must not resurrect a confirmed deletion after reload.
    await reconcileCloudShots(owner, snapshot([synced("removed")], true));
    expect(await getShot("removed")).toBeUndefined();
  });

  it.each([[true, false], [false, true]])("never infers a deletion from an incomplete snapshot (cache %s, pending %s)", async (cached, pending) => {
    await saveShot(synced("keep"));
    await reconcileCloudShots(owner, snapshot([], cached, pending));
    expect(await getShot("keep")).toBeDefined();
  });

  it("preserves pose frames and the device video reference while accepting remote summary edits", async () => {
    const local = { ...synced("clip"), poseFrames: syntheticShotFrames(), video: { localVideoId: "this-device", originalFileName: "clip.mp4" } };
    await saveShot(local);
    const remote = { ...synced("clip"), result: "missed" as const, video: { localVideoId: "other-device", storagePath: "remote/clip.mp4" } };
    const [result] = await reconcileCloudShots(owner, snapshot([remote]));
    expect(result.result).toBe("missed");
    expect(result.poseFrames).toEqual(local.poseFrames);
    expect(result.video).toEqual({ localVideoId: "this-device", originalFileName: "clip.mp4", storagePath: "remote/clip.mp4" });
    expect(await getShot("clip")).toEqual(result);
    const newcomer = { ...remote, id: "new" };
    await reconcileCloudShots(owner, snapshot([remote, newcomer]));
    expect((await getShot("new"))?.video?.localVideoId).toBeUndefined();
  });

  it("retains newer pending edits until a matching cloud write is acknowledged", async () => {
    const local = { ...synced("edit"), updatedAt: "2026-08-11T12:00:00.000Z", result: "missed" as const, sync: { status: "pending" as const, changedAt: "now" } };
    await saveShot(local);
    await reconcileCloudShots(owner, snapshot([synced("edit")]));
    expect(await getShot("edit")).toEqual(local);
    await reconcileCloudShots(owner, snapshot([{ ...local, sync: synced("edit").sync }]));
    expect((await getShot("edit"))?.sync.status).toBe("synced");
  });

  it("keeps offline deletions queued across reload and rejects stale cloud writes before and after acknowledgment", async () => {
    const shot = { ...synced("deleted"), video: { storagePath: "remote/deleted.mp4" } };
    await saveShot(shot);
    await deleteShot(shot.id);
    await closeLocalDatabase();
    expect(await listPendingShotDeletions(owner)).toEqual([{ id: shot.id, ownerId: owner, storagePath: "remote/deleted.mp4", pending: true }]);
    expect(await listPendingShotDeletions("another-user")).toEqual([]);
    await reconcileCloudShots(owner, snapshot([shot]));
    expect(await getShot(shot.id)).toBeUndefined();
    await acknowledgeShotDeletion(shot.id);
    expect(await listPendingShotDeletions(owner)).toEqual([]);
    await reconcileCloudShots(owner, snapshot([shot], true));
    await expect(saveShot(shot)).rejects.toThrow("deleted");
    expect(await getShot(shot.id)).toBeUndefined();
  });

  it("does not queue a cloud delete for anonymous local shots", async () => {
    const local = { ...shotRecord("local", "unknown", {}), ownerId: "local" };
    await saveShot(local);
    await deleteShot(local.id);
    expect(await listPendingShotDeletions("local")).toEqual([]);
  });
  it("retries failed cloud deletions after reload and only acknowledges a successful owner-scoped delete", async () => {
    const shot = synced("retry");
    await saveShot(shot);
    await deleteShot(shot.id);
    const removeShot = vi.fn().mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
    await expect(flushShotDeletions(owner, removeShot)).rejects.toThrow("Offline");
    await closeLocalDatabase();
    expect(await listPendingShotDeletions(owner)).toHaveLength(1);
    await flushShotDeletions(owner, removeShot);
    expect(removeShot).toHaveBeenNthCalledWith(2, shot.id, owner);
    expect(await listPendingShotDeletions(owner)).toEqual([]);
  });

  it("acknowledges queued deletions when the server confirms they are already absent", async () => {
    await saveShot(synced("already-gone"));
    await deleteShot("already-gone");
    await reconcileCloudShots(owner, snapshot([], true));
    expect(await listPendingShotDeletions(owner)).toHaveLength(1);
    await reconcileCloudShots(owner, snapshot([]));
    expect(await listPendingShotDeletions(owner)).toEqual([]);
  });

  it("upgrades an existing device database without changing stored shots", async () => {
    await closeLocalDatabase();
    await deleteDB("shotlab");
    const legacy = await openDB("shotlab", 1, {
      upgrade(db) {
        const shots = db.createObjectStore("shots", { keyPath: "id" });
        shots.createIndex("by-owner", "ownerId");
        shots.createIndex("by-recorded-at", "recordedAt");
        shots.createIndex("by-sync-status", "sync.status");
        db.createObjectStore("settings", { keyPath: "key" });
        const videos = db.createObjectStore("videos", { keyPath: "id" });
        videos.createIndex("by-shot", "shotId");
        videos.createIndex("by-owner", "ownerId");
        videos.createIndex("by-upload-status", "uploadStatus");
      },
    });
    const shot = { ...synced("legacy"), poseFrames: syntheticShotFrames() };
    await legacy.put("shots", shot);
    legacy.close();
    expect(await getShot(shot.id)).toEqual(shot);
    expect((await getLocalDatabase()).version).toBe(2);
    await deleteShot(shot.id);
    expect(await listPendingShotDeletions(owner)).toHaveLength(1);
  });

  it("includes a deletion queued while an earlier cloud delete is in flight", async () => {
    await saveShot(synced("first"));
    await saveShot(synced("second"));
    await deleteShot("first");
    const removeShot = vi.fn().mockImplementationOnce(async () => {
      await deleteShot("second");
    }).mockResolvedValue(undefined);
    await flushShotDeletions(owner, removeShot);
    expect(removeShot.mock.calls).toEqual([["first", owner], ["second", owner]]);
    expect(await listPendingShotDeletions(owner)).toEqual([]);
  });

});

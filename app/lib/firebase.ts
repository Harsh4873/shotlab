import type { FirebaseApp, FirebaseOptions } from "firebase/app";
import type { Auth, AuthCredential, User } from "firebase/auth";
import type { Firestore, QueryConstraint } from "firebase/firestore";
import type { FirebaseStorage } from "firebase/storage";

import {
  MAX_VIDEO_UPLOAD_BYTES,
  SHOT_RECORD_SCHEMA_VERSION,
  type GoogleAuthResult,
  type ResumableVideoUpload,
  type ShotLabUser,
  type ShotRecord,
  type Unsubscribe,
  type UploadedVideoAsset,
  type UploadTaskStatus,
  type VideoUploadProgress,
} from "./types";

interface ViteEnvironment {
  VITE_FIREBASE_API_KEY?: string;
  VITE_FIREBASE_AUTH_DOMAIN?: string;
  VITE_FIREBASE_PROJECT_ID?: string;
  VITE_FIREBASE_STORAGE_BUCKET?: string;
  VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  VITE_FIREBASE_APP_ID?: string;
}

const viteEnvironment = (
  import.meta as ImportMeta & { readonly env?: ViteEnvironment }
).env;

function publicEnvironmentValue(
  value: string | undefined,
  fallback: string,
): string {
  return value?.trim() || fallback;
}

/** Firebase web configuration is public; access is enforced by Auth and Rules. */
export const firebaseConfig: FirebaseOptions = {
  apiKey: publicEnvironmentValue(
    viteEnvironment?.VITE_FIREBASE_API_KEY,
    "AIzaSyCCAEyBDgIFfn7_zwvSsKHCN0gp_PHP5t0",
  ),
  authDomain: publicEnvironmentValue(
    viteEnvironment?.VITE_FIREBASE_AUTH_DOMAIN,
    "shotlab-harsh4873.firebaseapp.com",
  ),
  projectId: publicEnvironmentValue(
    viteEnvironment?.VITE_FIREBASE_PROJECT_ID,
    "shotlab-harsh4873",
  ),
  storageBucket: publicEnvironmentValue(
    viteEnvironment?.VITE_FIREBASE_STORAGE_BUCKET,
    "shotlab-harsh4873.firebasestorage.app",
  ),
  messagingSenderId: publicEnvironmentValue(
    viteEnvironment?.VITE_FIREBASE_MESSAGING_SENDER_ID,
    "261653909833",
  ),
  appId: publicEnvironmentValue(
    viteEnvironment?.VITE_FIREBASE_APP_ID,
    "1:261653909833:web:25df491e98aa2fed2f0a98",
  ),
};

interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
  authApi: typeof import("firebase/auth");
  firestoreApi: typeof import("firebase/firestore");
  storageApi: typeof import("firebase/storage");
}

export interface GooglePopupOptions {
  /** Link a current anonymous UID instead of replacing it. Defaults to true. */
  linkAnonymous?: boolean;
  /** Ask Google to show its account chooser. Defaults to true. */
  selectAccount?: boolean;
}

export interface CloudShotSnapshot {
  shots: ShotRecord[];
  fromCache: boolean;
  hasPendingWrites: boolean;
}

export interface CloudShotSubscriptionOptions {
  limit?: number;
  includeMetadataChanges?: boolean;
  onError?: (error: Error) => void;
}

export interface StartVideoUploadInput {
  shotId: string;
  data: Blob;
  videoId?: string;
  originalFileName?: string;
  contentType?: string;
  signal?: AbortSignal;
  onProgress?: (progress: VideoUploadProgress) => void;
}

export class FirebaseClientUnavailableError extends Error {
  readonly code = "firebase/client-unavailable";

  constructor() {
    super("Firebase client services are only available in the browser.");
    this.name = "FirebaseClientUnavailableError";
  }
}

export class FirebaseAuthRequiredError extends Error {
  readonly code = "firebase/auth-required";

  constructor() {
    super("Sign in before accessing synced ShotLab data.");
    this.name = "FirebaseAuthRequiredError";
  }
}

export class FirebasePermanentAccountRequiredError extends Error {
  readonly code = "firebase/permanent-account-required";

  constructor() {
    super("Link a Google account before uploading videos.");
    this.name = "FirebasePermanentAccountRequiredError";
  }
}

export class FirebaseOwnershipError extends Error {
  readonly code = "firebase/owner-mismatch";

  constructor() {
    super("The signed-in user does not own this ShotLab record.");
    this.name = "FirebaseOwnershipError";
  }
}

export class AnonymousAccountLinkConflictError extends Error {
  readonly code = "auth/credential-already-in-use";
  readonly previousAnonymousUid: string;
  readonly credential: AuthCredential | null;
  readonly originalError: unknown;

  constructor(
    previousAnonymousUid: string,
    credential: AuthCredential | null,
    originalError: unknown,
  ) {
    super(
      "That Google account already has ShotLab data. Resolve the local guest data before switching accounts.",
    );
    this.name = "AnonymousAccountLinkConflictError";
    this.previousAnonymousUid = previousAnonymousUid;
    this.credential = credential;
    this.originalError = originalError;
  }
}

let servicesPromise: Promise<FirebaseServices> | null = null;

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeIdentifier(value: string, fallback: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized || fallback;
}

function createId(prefix: string): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}_${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }

  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toShotLabUser(user: User): ShotLabUser {
  return {
    uid: user.uid,
    isAnonymous: user.isAnonymous,
    displayName: user.displayName,
    email: user.email,
    photoUrl: user.photoURL,
  };
}

async function initializeFirebaseServices(): Promise<FirebaseServices> {
  if (!isBrowser()) {
    throw new FirebaseClientUnavailableError();
  }

  const [appApi, authApi, firestoreApi, storageApi] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore"),
    import("firebase/storage"),
  ]);

  const app =
    appApi.getApps().find((candidate) => candidate.name === "[DEFAULT]") ??
    appApi.initializeApp(firebaseConfig);
  const auth = authApi.getAuth(app);

  let db: Firestore;
  try {
    db = firestoreApi.initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: firestoreApi.persistentLocalCache({
        tabManager: firestoreApi.persistentMultipleTabManager(),
      }),
    });
  } catch {
    // Another client module may have initialized Firestore first. Reuse it
    // rather than creating a second instance; it remains fully functional.
    db = firestoreApi.getFirestore(app);
  }

  return {
    app,
    auth,
    db,
    storage: storageApi.getStorage(app),
    authApi,
    firestoreApi,
    storageApi,
  };
}

async function getFirebaseServices(): Promise<FirebaseServices> {
  if (!servicesPromise) {
    servicesPromise = initializeFirebaseServices().catch((error: unknown) => {
      servicesPromise = null;
      throw error;
    });
  }

  return servicesPromise;
}

async function readyUser(
  services: FirebaseServices,
): Promise<User | null> {
  await services.auth.authStateReady();
  return services.auth.currentUser;
}

async function requireUser(services: FirebaseServices): Promise<User> {
  const user = await readyUser(services);
  if (!user) throw new FirebaseAuthRequiredError();
  return user;
}

async function requireOwner(
  services: FirebaseServices,
  ownerId?: string,
): Promise<User> {
  const user = await requireUser(services);
  if (ownerId !== undefined && user.uid !== ownerId) {
    throw new FirebaseOwnershipError();
  }
  return user;
}

export function isFirebaseClientAvailable(): boolean {
  return isBrowser();
}

export async function getCurrentUser(): Promise<ShotLabUser | null> {
  const services = await getFirebaseServices();
  const user = await readyUser(services);
  return user ? toShotLabUser(user) : null;
}

export async function observeAuthSession(
  listener: (user: ShotLabUser | null) => void,
  onError?: (error: Error) => void,
): Promise<Unsubscribe> {
  const services = await getFirebaseServices();
  return services.authApi.onAuthStateChanged(
    services.auth,
    (user) => listener(user ? toShotLabUser(user) : null),
    (error) => onError?.(error),
  );
}

/** Call when a guest first needs cloud-protected state, not on every startup. */
export async function ensureAnonymousUser(): Promise<ShotLabUser> {
  const services = await getFirebaseServices();
  const currentUser = await readyUser(services);
  if (currentUser) return toShotLabUser(currentUser);

  const result = await services.authApi.signInAnonymously(services.auth);
  return toShotLabUser(result.user);
}

export async function signInWithGooglePopup(
  options: GooglePopupOptions = {},
): Promise<GoogleAuthResult> {
  const services = await getFirebaseServices();
  const currentUser = await readyUser(services);
  const provider = new services.authApi.GoogleAuthProvider();

  if (options.selectAccount !== false) {
    provider.setCustomParameters({ prompt: "select_account" });
  }

  if (currentUser?.isAnonymous && options.linkAnonymous !== false) {
    try {
      const result = await services.authApi.linkWithPopup(currentUser, provider);
      return { action: "linked", user: toShotLabUser(result.user) };
    } catch (error) {
      if (errorCode(error) === "auth/credential-already-in-use") {
        const credential = services.authApi.GoogleAuthProvider.credentialFromError(
          error as Parameters<
            typeof services.authApi.GoogleAuthProvider.credentialFromError
          >[0],
        );
        throw new AnonymousAccountLinkConflictError(
          currentUser.uid,
          credential,
          error,
        );
      }
      throw error;
    }
  }

  const result = await services.authApi.signInWithPopup(services.auth, provider);
  return { action: "signed-in", user: toShotLabUser(result.user) };
}

/**
 * Switches to an existing Google account after the caller has preserved or
 * deliberately discarded records owned by the temporary anonymous UID.
 */
export async function continueAfterAnonymousLinkConflict(
  conflict: AnonymousAccountLinkConflictError,
): Promise<GoogleAuthResult> {
  if (!conflict.credential) throw conflict.originalError;

  const services = await getFirebaseServices();
  const result = await services.authApi.signInWithCredential(
    services.auth,
    conflict.credential,
  );
  return { action: "signed-in", user: toShotLabUser(result.user) };
}

export async function signOutCurrentUser(): Promise<void> {
  const services = await getFirebaseServices();
  await services.authApi.signOut(services.auth);
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }

  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => [key, removeUndefined(child)]),
      );
    }
  }

  return value;
}

function remoteTimestampIso(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    const date = value.toDate();
    return date instanceof Date ? date.toISOString() : undefined;
  }

  return undefined;
}

function cloudShotData(
  shot: ShotRecord,
  remoteUpdatedAt: unknown,
): Record<string, unknown> {
  const cloudShot = { ...shot } as Partial<ShotRecord> &
    Record<string, unknown>;
  delete cloudShot.poseFrames;
  delete cloudShot.sync;
  return {
    ...(removeUndefined(cloudShot) as Record<string, unknown>),
    remoteUpdatedAt,
  };
}

function shotFromCloudDocument(
  documentId: string,
  data: Record<string, unknown>,
  hasPendingWrites: boolean,
): ShotRecord {
  const { remoteUpdatedAt, ...record } = data;
  const syncedAt = remoteTimestampIso(remoteUpdatedAt);
  const changedAt = syncedAt ?? nowIso();

  return {
    ...(record as unknown as Omit<ShotRecord, "sync">),
    schemaVersion: SHOT_RECORD_SCHEMA_VERSION,
    id: documentId,
    poseFrames: undefined,
    sync: {
      status: hasPendingWrites ? "syncing" : "synced",
      changedAt,
      lastSyncedAt: hasPendingWrites ? undefined : changedAt,
    },
  };
}

export async function saveShotToCloud(shot: ShotRecord): Promise<ShotRecord> {
  const services = await getFirebaseServices();
  await requireOwner(services, shot.ownerId);
  const remoteUpdatedAt = services.firestoreApi.serverTimestamp();
  const reference = services.firestoreApi.doc(
    services.db,
    "users",
    shot.ownerId,
    "shots",
    shot.id,
  );

  await services.firestoreApi.setDoc(
    reference,
    cloudShotData(shot, remoteUpdatedAt),
    { merge: true },
  );

  const syncedAt = nowIso();
  return {
    ...shot,
    sync: {
      status: "synced",
      changedAt: syncedAt,
      lastAttemptAt: shot.sync.lastAttemptAt,
      lastSyncedAt: syncedAt,
    },
  };
}

export async function deleteShotFromCloud(shotId: string): Promise<void> {
  const services = await getFirebaseServices();
  const user = await requireUser(services);
  const reference = services.firestoreApi.doc(
    services.db,
    "users",
    user.uid,
    "shots",
    shotId,
  );
  await services.firestoreApi.deleteDoc(reference);
}

export async function subscribeToCloudShots(
  listener: (snapshot: CloudShotSnapshot) => void,
  options: CloudShotSubscriptionOptions = {},
): Promise<Unsubscribe> {
  const services = await getFirebaseServices();
  const user = await requireUser(services);
  const collection = services.firestoreApi.collection(
    services.db,
    "users",
    user.uid,
    "shots",
  );
  const constraints: QueryConstraint[] = [
    services.firestoreApi.orderBy("recordedAt", "desc"),
  ];

  if (options.limit !== undefined) {
    constraints.push(
      services.firestoreApi.limit(Math.max(1, Math.floor(options.limit))),
    );
  }

  const shotQuery = services.firestoreApi.query(collection, ...constraints);

  return services.firestoreApi.onSnapshot(
    shotQuery,
    { includeMetadataChanges: options.includeMetadataChanges ?? true },
    (querySnapshot) => {
      const shots = querySnapshot.docs.map((document) =>
        shotFromCloudDocument(
          document.id,
          document.data(),
          document.metadata.hasPendingWrites,
        ),
      );
      listener({
        shots,
        fromCache: querySnapshot.metadata.fromCache,
        hasPendingWrites: querySnapshot.metadata.hasPendingWrites,
      });
    },
    (error) => options.onError?.(error),
  );
}

function uploadProgress(
  videoId: string,
  shotId: string,
  storagePath: string,
  status: UploadTaskStatus,
  bytesTransferred: number,
  totalBytes: number,
  error?: string,
): VideoUploadProgress {
  const progressRatio = totalBytes > 0 ? bytesTransferred / totalBytes : 0;
  return {
    videoId,
    shotId,
    storagePath,
    status,
    bytesTransferred,
    totalBytes,
    progressRatio,
    progressPct: progressRatio * 100,
    error,
  };
}

export async function startResumableVideoUpload(
  input: StartVideoUploadInput,
): Promise<ResumableVideoUpload> {
  const services = await getFirebaseServices();
  const user = await requireUser(services);
  if (user.isAnonymous) throw new FirebasePermanentAccountRequiredError();
  if (input.data.size > MAX_VIDEO_UPLOAD_BYTES) {
    throw new RangeError(
      `Videos must be ${MAX_VIDEO_UPLOAD_BYTES} bytes or smaller.`,
    );
  }

  const shotId = input.shotId.trim();
  if (!shotId) throw new TypeError("shotId must be a non-empty string.");
  const videoId = input.videoId?.trim() || createId("video");
  const storageShotId = safeIdentifier(shotId, "shot");
  const storageVideoId = safeIdentifier(videoId, "video");
  const storagePath = `users/${user.uid}/videos/${storageShotId}/${storageVideoId}`;
  const contentType = input.contentType || input.data.type || "video/mp4";
  const originalFileName =
    input.originalFileName ||
    (typeof File !== "undefined" && input.data instanceof File
      ? input.data.name
      : `${shotId}.mp4`);
  const storageReference = services.storageApi.ref(
    services.storage,
    storagePath,
  );
  const task = services.storageApi.uploadBytesResumable(
    storageReference,
    input.data,
    {
      contentType,
      customMetadata: {
        ownerId: user.uid,
        shotId: storageShotId,
        videoId: storageVideoId,
        recordShotId: shotId,
        recordVideoId: videoId,
        originalFileName,
      },
    },
  );
  const listeners = new Set<(progress: VideoUploadProgress) => void>();
  if (input.onProgress) listeners.add(input.onProgress);

  let latestProgress = uploadProgress(
    videoId,
    shotId,
    storagePath,
    "running",
    0,
    input.data.size,
  );

  const emit = (progress: VideoUploadProgress) => {
    latestProgress = progress;
    for (const listener of listeners) {
      try {
        listener(progress);
      } catch {
        // A rendering callback must not be able to interrupt the upload task.
      }
    }
  };

  const abort = () => task.cancel();
  input.signal?.addEventListener("abort", abort, { once: true });

  const completion = new Promise<UploadedVideoAsset>((resolve, reject) => {
    task.on(
      "state_changed",
      (snapshot) => {
        emit(
          uploadProgress(
            videoId,
            shotId,
            storagePath,
            snapshot.state === "paused" ? "paused" : "running",
            snapshot.bytesTransferred,
            snapshot.totalBytes,
          ),
        );
      },
      (error) => {
        const status: UploadTaskStatus =
          errorCode(error) === "storage/canceled" ? "canceled" : "error";
        emit(
          uploadProgress(
            videoId,
            shotId,
            storagePath,
            status,
            task.snapshot.bytesTransferred,
            task.snapshot.totalBytes,
            errorMessage(error),
          ),
        );
        input.signal?.removeEventListener("abort", abort);
        reject(error);
      },
      async () => {
        try {
          const downloadUrl = await services.storageApi.getDownloadURL(
            task.snapshot.ref,
          );
          emit(
            uploadProgress(
              videoId,
              shotId,
              storagePath,
              "success",
              task.snapshot.totalBytes,
              task.snapshot.totalBytes,
            ),
          );
          input.signal?.removeEventListener("abort", abort);
          resolve({
            videoId,
            shotId,
            ownerId: user.uid,
            storagePath,
            downloadUrl,
            contentType,
            sizeBytes: task.snapshot.totalBytes,
            uploadedAt: nowIso(),
          });
        } catch (error) {
          emit(
            uploadProgress(
              videoId,
              shotId,
              storagePath,
              "error",
              task.snapshot.bytesTransferred,
              task.snapshot.totalBytes,
              errorMessage(error),
            ),
          );
          input.signal?.removeEventListener("abort", abort);
          reject(error);
        }
      },
    );
  });

  if (input.signal?.aborted) abort();

  return {
    videoId,
    shotId,
    storagePath,
    completion,
    pause: () => task.pause(),
    resume: () => task.resume(),
    cancel: () => task.cancel(),
    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(latestProgress);
      } catch {
        // Match subsequent notifications: observers cannot interrupt uploads.
      }
      return () => listeners.delete(listener);
    },
  };
}

export async function uploadShotVideo(
  input: StartVideoUploadInput,
): Promise<UploadedVideoAsset> {
  const upload = await startResumableVideoUpload(input);
  return upload.completion;
}

async function requireOwnedStoragePath(
  services: FirebaseServices,
  storagePath: string,
): Promise<User> {
  const user = await requireOwner(services);
  if (!storagePath.startsWith(`users/${user.uid}/videos/`)) {
    throw new FirebaseOwnershipError();
  }
  return user;
}

export async function getVideoDownloadUrl(
  storagePath: string,
): Promise<string> {
  const services = await getFirebaseServices();
  await requireOwnedStoragePath(services, storagePath);
  return services.storageApi.getDownloadURL(
    services.storageApi.ref(services.storage, storagePath),
  );
}

export async function deleteVideoFromCloud(
  storagePath: string,
): Promise<void> {
  const services = await getFirebaseServices();
  await requireOwnedStoragePath(services, storagePath);
  await services.storageApi.deleteObject(
    services.storageApi.ref(services.storage, storagePath),
  );
}

export const firebaseAuth = {
  observe: observeAuthSession,
  currentUser: getCurrentUser,
  ensureAnonymous: ensureAnonymousUser,
  signInWithGoogle: signInWithGooglePopup,
  continueAfterLinkConflict: continueAfterAnonymousLinkConflict,
  signOut: signOutCurrentUser,
};

export const cloudShotStore = {
  save: saveShotToCloud,
  subscribe: subscribeToCloudShots,
  delete: deleteShotFromCloud,
};

export const cloudVideoStore = {
  startUpload: startResumableVideoUpload,
  upload: uploadShotVideo,
  getDownloadUrl: getVideoDownloadUrl,
  delete: deleteVideoFromCloud,
};

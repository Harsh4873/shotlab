/** Shared domain types for local analysis, persistence, and Firebase sync. */

export const SHOT_RECORD_SCHEMA_VERSION = 1 as const;
export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const MAX_VIDEO_UPLOAD_BYTES = 500 * 1024 * 1024;

export const POSE_LANDMARK_NAMES = [
  "nose",
  "leftEyeInner",
  "leftEye",
  "leftEyeOuter",
  "rightEyeInner",
  "rightEye",
  "rightEyeOuter",
  "leftEar",
  "rightEar",
  "mouthLeft",
  "mouthRight",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftPinky",
  "rightPinky",
  "leftIndex",
  "rightIndex",
  "leftThumb",
  "rightThumb",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftHeel",
  "rightHeel",
  "leftFootIndex",
  "rightFootIndex",
] as const;

export type PoseLandmarkName = (typeof POSE_LANDMARK_NAMES)[number];
export type Handedness = "left" | "right" | "unknown";
export type CameraView = "side" | "three-quarter" | "front" | "unknown";
export type MeasurementUnits = "metric" | "imperial";
export type ShotResult = "made" | "missed" | "unknown";
export type ShotProcessingStatus =
  | "draft"
  | "analyzing"
  | "ready"
  | "failed";

export type ShotSyncStatus =
  | "local-only"
  | "pending"
  | "syncing"
  | "synced"
  | "conflict"
  | "error";

export type VideoUploadStatus =
  | "local"
  | "queued"
  | "uploading"
  | "paused"
  | "uploaded"
  | "failed"
  | "canceled";

export type UploadTaskStatus =
  | "running"
  | "paused"
  | "success"
  | "canceled"
  | "error";

export interface PoseLandmark {
  /** MediaPipe landmark index in the canonical 33-landmark model. */
  index: number;
  name?: PoseLandmarkName;
  /** Normalized image coordinates for image-space landmarks. */
  x: number;
  y: number;
  /** Image-relative depth or meters for world-space landmarks. */
  z: number;
  visibility?: number;
  presence?: number;
}

export interface TrackedObjectPoint {
  x: number;
  y: number;
  confidence?: number;
  trackingId?: string;
  width?: number;
  height?: number;
}

export interface PoseFrame {
  frameIndex: number;
  timestampMs: number;
  landmarks: PoseLandmark[];
  worldLandmarks?: PoseLandmark[];
  poseConfidence?: number;
  ball?: TrackedObjectPoint;
  rim?: TrackedObjectPoint;
}

export interface ShotMetrics {
  releaseFrame?: number;
  releaseTimingSeconds?: number;
  elbowAngleDeg?: number;
  leftElbowAngleDeg?: number;
  rightElbowAngleDeg?: number;
  kneeAngleDeg?: number;
  leftKneeAngleDeg?: number;
  rightKneeAngleDeg?: number;
  hipAngleDeg?: number;
  torsoLeanDeg?: number;
  shoulderTiltDeg?: number;
  baseWidthRatio?: number;
  jumpHeightProxy?: number;
  jumpDrift?: number;
  landingWidthRatio?: number;
  landingDisplacement?: number;
  landingLateralDisplacement?: number;
  releaseConsistencyPct?: number;
  arcAngleDeg?: number;
  dominantSide?: Handedness;
  confidence?: number;
}

export interface PoseAnalysisSummary {
  frameCount: number;
  analyzedFps?: number;
  releaseFrame?: number;
  loadFrame?: number;
  takeoffFrame?: number;
  landingFrame?: number;
  modelVersion?: string;
}

export interface ShotCaptureMetadata {
  originalFileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
  cameraView?: CameraView;
  handedness?: Handedness;
}

export interface ShotVideoReference {
  localVideoId?: string;
  storagePath?: string;
  downloadUrl?: string;
  originalFileName?: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
}

export interface ShotSyncState {
  status: ShotSyncStatus;
  changedAt: string;
  lastAttemptAt?: string;
  lastSyncedAt?: string;
  error?: string;
}

export interface ShotRecord {
  schemaVersion: typeof SHOT_RECORD_SCHEMA_VERSION;
  id: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  recordedAt: string;
  status: ShotProcessingStatus;
  result: ShotResult;
  metrics: ShotMetrics;
  poseSummary?: PoseAnalysisSummary;
  /** Full pose frames are local-only; cloud writes intentionally omit them. */
  poseFrames?: PoseFrame[];
  capture?: ShotCaptureMetadata;
  video?: ShotVideoReference;
  notes?: string;
  tags?: string[];
  analysisError?: string;
  sync: ShotSyncState;
}

export interface ShotLabSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  handedness: Handedness;
  preferredCameraView: CameraView;
  units: MeasurementUnits;
  autoUploadVideos: boolean;
  keepLocalVideos: boolean;
  enableOfflineCache: boolean;
  showPoseOverlay: boolean;
  analysisFps: number;
  updatedAt: string;
}

export const DEFAULT_SHOTLAB_SETTINGS: Readonly<ShotLabSettings> = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  handedness: "unknown",
  preferredCameraView: "three-quarter",
  units: "metric",
  autoUploadVideos: false,
  keepLocalVideos: true,
  enableOfflineCache: true,
  showPoseOverlay: true,
  analysisFps: 30,
  updatedAt: "1970-01-01T00:00:00.000Z",
};

export interface StoredVideoRecord {
  id: string;
  shotId: string;
  ownerId: string;
  blob: Blob;
  originalFileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  uploadStatus: VideoUploadStatus;
  uploadedBytes: number;
  storagePath?: string;
  downloadUrl?: string;
  error?: string;
}

export interface VideoUploadProgress {
  videoId: string;
  shotId: string;
  storagePath: string;
  status: UploadTaskStatus;
  bytesTransferred: number;
  totalBytes: number;
  progressRatio: number;
  progressPct: number;
  error?: string;
}

export interface UploadedVideoAsset {
  videoId: string;
  shotId: string;
  ownerId: string;
  storagePath: string;
  downloadUrl: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface ShotLabUser {
  uid: string;
  isAnonymous: boolean;
  displayName: string | null;
  email: string | null;
  photoUrl: string | null;
}

export type GoogleAuthAction = "linked" | "signed-in";

export interface GoogleAuthResult {
  action: GoogleAuthAction;
  user: ShotLabUser;
}

export type Unsubscribe = () => void;

export interface ResumableVideoUpload {
  videoId: string;
  shotId: string;
  storagePath: string;
  completion: Promise<UploadedVideoAsset>;
  pause(): boolean;
  resume(): boolean;
  cancel(): boolean;
  subscribe(listener: (progress: VideoUploadProgress) => void): Unsubscribe;
}

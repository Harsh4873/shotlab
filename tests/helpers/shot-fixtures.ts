import type {
  PoseFrame,
  PoseLandmark,
  ShotMetrics,
  ShotRecord,
  ShotResult,
} from "../../app/lib/types";

const LANDMARK = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
} as const;

const LEFT_VISIBILITY = 0.72;
const RIGHT_VISIBILITY = 0.98;

function landmark(
  index: number,
  x: number,
  y: number,
  visibility = 0.9,
): PoseLandmark {
  return { index, x, y, z: 0, visibility, presence: visibility };
}

function setLandmark(
  landmarks: PoseLandmark[],
  index: number,
  x: number,
  y: number,
  visibility: number,
) {
  landmarks[index] = landmark(index, x, y, visibility);
}

/**
 * A deliberately simple eight-frame shooting motion.
 *
 * - frame 1 is the deepest knee load (90 degrees)
 * - frame 1 begins upward motion
 * - frame 4 has the strongest upward wrist movement and is the release estimate
 * - frame 5 is peak hip height
 * - frame 7 returns to the landing band
 *
 * Distances are normalized so the load base is 1.2 shoulder widths, release
 * drift is 0.2 shoulder widths, and landing displacement is 0.1.
 */
export function syntheticShotFrames(): PoseFrame[] {
  const hipY = [0.6, 0.64, 0.62, 0.57, 0.51, 0.46, 0.5, 0.61];
  const hipX = [0.5, 0.5, 0.505, 0.512, 0.52, 0.522, 0.518, 0.51];
  const wristY = [0.5, 0.48, 0.44, 0.38, 0.1, 0.05, 0.16, 0.3];

  return hipY.map((currentHipY, frameIndex) => {
    const currentHipX = hipX[frameIndex];
    const shoulderCenterX = currentHipX + 0.01;
    const shoulderY = currentHipY - 0.3;
    const landmarks = Array.from({ length: 33 }, (_, index) =>
      landmark(index, currentHipX, currentHipY, 0.05),
    );

    setLandmark(
      landmarks,
      LANDMARK.nose,
      currentHipX,
      currentHipY - 0.5,
      0.95,
    );
    setLandmark(
      landmarks,
      LANDMARK.leftShoulder,
      shoulderCenterX - 0.05,
      shoulderY,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightShoulder,
      shoulderCenterX + 0.05,
      shoulderY,
      RIGHT_VISIBILITY,
    );

    const currentWristY = wristY[frameIndex];
    setLandmark(
      landmarks,
      LANDMARK.leftWrist,
      shoulderCenterX - 0.12,
      currentWristY,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightWrist,
      shoulderCenterX + 0.12,
      currentWristY,
      RIGHT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.leftElbow,
      shoulderCenterX - 0.08,
      (shoulderY + currentWristY) / 2 + 0.02,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightElbow,
      shoulderCenterX + 0.08,
      (shoulderY + currentWristY) / 2 + 0.02,
      RIGHT_VISIBILITY,
    );

    setLandmark(
      landmarks,
      LANDMARK.leftHip,
      currentHipX - 0.03,
      currentHipY,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightHip,
      currentHipX + 0.03,
      currentHipY,
      RIGHT_VISIBILITY,
    );

    const kneeY = currentHipY + 0.12;
    setLandmark(
      landmarks,
      LANDMARK.leftKnee,
      currentHipX - 0.03,
      kneeY,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightKnee,
      currentHipX + 0.03,
      kneeY,
      RIGHT_VISIBILITY,
    );

    if (frameIndex === 1) {
      // Horizontal shins make both load-frame knees exactly 90 degrees.
      setLandmark(
        landmarks,
        LANDMARK.leftAnkle,
        currentHipX - 0.15,
        kneeY,
        LEFT_VISIBILITY,
      );
      setLandmark(
        landmarks,
        LANDMARK.rightAnkle,
        currentHipX + 0.15,
        kneeY,
        RIGHT_VISIBILITY,
      );
    } else {
      setLandmark(
        landmarks,
        LANDMARK.leftAnkle,
        currentHipX - 0.03,
        currentHipY + 0.24,
        LEFT_VISIBILITY,
      );
      setLandmark(
        landmarks,
        LANDMARK.rightAnkle,
        currentHipX + 0.03,
        currentHipY + 0.24,
        RIGHT_VISIBILITY,
      );
    }

    // Foot midpoints are 0.12 apart and shoulders are 0.10 apart.
    setLandmark(
      landmarks,
      LANDMARK.leftHeel,
      currentHipX - 0.065,
      currentHipY + 0.25,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.leftFootIndex,
      currentHipX - 0.055,
      currentHipY + 0.25,
      LEFT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightHeel,
      currentHipX + 0.055,
      currentHipY + 0.25,
      RIGHT_VISIBILITY,
    );
    setLandmark(
      landmarks,
      LANDMARK.rightFootIndex,
      currentHipX + 0.065,
      currentHipY + 0.25,
      RIGHT_VISIBILITY,
    );

    return {
      frameIndex,
      timestampMs: frameIndex * 100,
      landmarks,
      poseConfidence: 0.96,
    };
  });
}

export function transformFrames(
  frames: PoseFrame[],
  scale: number,
  translate = { x: 0, y: 0, z: 0 },
): PoseFrame[] {
  const transform = (point: PoseLandmark): PoseLandmark => ({
    ...point,
    x: point.x * scale + translate.x,
    y: point.y * scale + translate.y,
    z: point.z * scale + translate.z,
  });

  return frames.map((frame) => ({
    ...frame,
    landmarks: frame.landmarks.map(transform),
    worldLandmarks: frame.worldLandmarks?.map(transform),
  }));
}

export function shotRecord(
  id: string,
  result: ShotResult,
  metrics: ShotMetrics,
): ShotRecord {
  const timestamp = "2026-08-10T12:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    ownerId: "test-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    recordedAt: timestamp,
    status: "ready",
    result,
    metrics,
    sync: { status: "local-only", changedAt: timestamp },
  };
}

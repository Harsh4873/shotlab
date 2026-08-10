import type {
  Handedness,
  PoseAnalysisSummary,
  PoseFrame,
  PoseLandmark,
  ShotMetrics,
  ShotRecord,
} from "./types";

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

const MIN_VISIBILITY = 0.35;
const EPSILON = 1e-7;

export interface AnalysisOptions {
  preferredSide?: Handedness;
  releaseFrameOverride?: number;
  history?: ShotRecord[];
}

export interface AnalysisResult {
  metrics: ShotMetrics;
  summary: PoseAnalysisSummary;
}

export interface MetricAggregate {
  count: number;
  mean?: number;
  standardDeviation?: number;
}

export interface OutcomeComparison {
  key: keyof ShotMetrics;
  label: string;
  unit: string;
  made: MetricAggregate;
  missed: MetricAggregate;
  current?: number;
}

export interface CoachingInsight {
  title: string;
  detail: string;
  metric?: keyof ShotMetrics;
  strength?: number;
}

const METRIC_DEFINITIONS: Array<{
  key: keyof ShotMetrics;
  label: string;
  unit: string;
}> = [
  { key: "elbowAngleDeg", label: "Release elbow", unit: "°" },
  { key: "kneeAngleDeg", label: "Knee at load", unit: "°" },
  { key: "torsoLeanDeg", label: "Torso lean", unit: "°" },
  { key: "baseWidthRatio", label: "Base width", unit: "×" },
  { key: "jumpDrift", label: "Forward drift", unit: "×" },
  { key: "releaseTimingSeconds", label: "Release timing", unit: "s" },
];

function visible(point?: PoseLandmark): point is PoseLandmark {
  return Boolean(point) && (point?.visibility ?? 1) >= MIN_VISIBILITY;
}

function point(frame: PoseFrame, index: number, world = false) {
  const source = world ? frame.worldLandmarks : frame.landmarks;
  const candidate = source?.[index];
  return visible(candidate) ? candidate : undefined;
}

function distance(a?: PoseLandmark, b?: PoseLandmark) {
  if (!a || !b) return undefined;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a?: PoseLandmark, b?: PoseLandmark): PoseLandmark | undefined {
  if (!a || !b) return undefined;
  return {
    index: -1,
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

export function angleBetween(
  first?: Pick<PoseLandmark, "x" | "y" | "z">,
  vertex?: Pick<PoseLandmark, "x" | "y" | "z">,
  third?: Pick<PoseLandmark, "x" | "y" | "z">,
) {
  if (!first || !vertex || !third) return undefined;
  const a = {
    x: first.x - vertex.x,
    y: first.y - vertex.y,
    z: first.z - vertex.z,
  };
  const b = {
    x: third.x - vertex.x,
    y: third.y - vertex.y,
    z: third.z - vertex.z,
  };
  const lengthA = Math.hypot(a.x, a.y, a.z);
  const lengthB = Math.hypot(b.x, b.y, b.z);
  if (lengthA < EPSILON || lengthB < EPSILON) return undefined;
  const cosine = Math.min(
    1,
    Math.max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / (lengthA * lengthB)),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function average(values: Array<number | undefined>) {
  const finite = values.filter((value): value is number => Number.isFinite(value));
  if (!finite.length) return undefined;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance);
}

function movingAverage(values: Array<number | undefined>, radius = 2) {
  return values.map((_, index) => {
    const nearby = values.slice(
      Math.max(0, index - radius),
      Math.min(values.length, index + radius + 1),
    );
    return average(nearby);
  });
}

function jointAngle(
  frame: PoseFrame,
  first: number,
  vertex: number,
  third: number,
) {
  const worldPoints = [
    point(frame, first, true),
    point(frame, vertex, true),
    point(frame, third, true),
  ];
  if (worldPoints.every(Boolean)) {
    return angleBetween(worldPoints[0], worldPoints[1], worldPoints[2]);
  }
  return angleBetween(
    point(frame, first),
    point(frame, vertex),
    point(frame, third),
  );
}

function sideIndices(side: "left" | "right") {
  return side === "left"
    ? {
        shoulder: LANDMARK.leftShoulder,
        elbow: LANDMARK.leftElbow,
        wrist: LANDMARK.leftWrist,
        hip: LANDMARK.leftHip,
        knee: LANDMARK.leftKnee,
        ankle: LANDMARK.leftAnkle,
      }
    : {
        shoulder: LANDMARK.rightShoulder,
        elbow: LANDMARK.rightElbow,
        wrist: LANDMARK.rightWrist,
        hip: LANDMARK.rightHip,
        knee: LANDMARK.rightKnee,
        ankle: LANDMARK.rightAnkle,
      };
}

function sideVisibility(frame: PoseFrame, side: "left" | "right") {
  const indices = sideIndices(side);
  return average(
    Object.values(indices).map((index) => frame.landmarks[index]?.visibility ?? 0),
  );
}

export function selectDominantSide(
  frames: PoseFrame[],
  preferred: Handedness = "unknown",
): "left" | "right" {
  if (preferred === "left" || preferred === "right") return preferred;
  const left = median(
    frames
      .map((frame) => sideVisibility(frame, "left"))
      .filter((value): value is number => value !== undefined),
  );
  const right = median(
    frames
      .map((frame) => sideVisibility(frame, "right"))
      .filter((value): value is number => value !== undefined),
  );
  return (right ?? 0) >= (left ?? 0) ? "right" : "left";
}

function closestFrameIndex(frames: PoseFrame[], targetFrame: number) {
  let closest = 0;
  let delta = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const candidate = Math.abs(frame.frameIndex - targetFrame);
    if (candidate < delta) {
      delta = candidate;
      closest = index;
    }
  });
  return closest;
}

function findReleaseIndex(
  frames: PoseFrame[],
  side: "left" | "right",
  override?: number,
) {
  if (override !== undefined) return closestFrameIndex(frames, override);
  const indices = sideIndices(side);
  const elbows = movingAverage(
    frames.map((frame) =>
      jointAngle(frame, indices.shoulder, indices.elbow, indices.wrist),
    ),
  );
  let bestIndex = Math.min(frames.length - 1, Math.floor(frames.length * 0.55));
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 1; index < frames.length; index += 1) {
    const progress = index / Math.max(1, frames.length - 1);
    if (progress < 0.12 || progress > 0.92) continue;
    const currentWrist = point(frames[index], indices.wrist);
    const previousWrist = point(frames[index - 1], indices.wrist);
    const shoulder = point(frames[index], indices.shoulder);
    const currentElbow = elbows[index];
    const previousElbow = elbows[index - 1];
    const deltaMs = Math.max(
      1,
      frames[index].timestampMs - frames[index - 1].timestampMs,
    );
    if (!currentWrist || !previousWrist || !shoulder || currentElbow === undefined) {
      continue;
    }
    const upwardVelocity = ((previousWrist.y - currentWrist.y) * 1000) / deltaMs;
    const extensionVelocity =
      previousElbow === undefined
        ? 0
        : ((currentElbow - previousElbow) * 1000) / deltaMs / 180;
    const aboveShoulder = shoulder.y - currentWrist.y;
    const extensionGate = currentElbow >= 115 ? 0.25 : -0.5;
    const score =
      upwardVelocity * 2.5 +
      Math.max(0, extensionVelocity) +
      aboveShoulder * 0.9 +
      extensionGate;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function findLoadIndex(
  frames: PoseFrame[],
  side: "left" | "right",
  releaseIndex: number,
) {
  const indices = sideIndices(side);
  let loadIndex = 0;
  let smallestKneeAngle = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= releaseIndex; index += 1) {
    const knee = jointAngle(frameAt(frames, index), indices.hip, indices.knee, indices.ankle);
    if (knee !== undefined && knee < smallestKneeAngle) {
      smallestKneeAngle = knee;
      loadIndex = index;
    }
  }
  return loadIndex;
}

function frameAt(frames: PoseFrame[], index: number) {
  return frames[Math.max(0, Math.min(frames.length - 1, index))];
}

function hipCenter(frame: PoseFrame) {
  return midpoint(point(frame, LANDMARK.leftHip), point(frame, LANDMARK.rightHip));
}

function shoulderCenter(frame: PoseFrame) {
  return midpoint(
    point(frame, LANDMARK.leftShoulder),
    point(frame, LANDMARK.rightShoulder),
  );
}

function findUpwardMotionIndex(frames: PoseFrame[], loadIndex: number, releaseIndex: number) {
  const hips = movingAverage(frames.map((frame) => hipCenter(frame)?.y), 1);
  for (let index = Math.max(1, loadIndex); index <= releaseIndex; index += 1) {
    const previous = hips[index - 1];
    const current = hips[index];
    if (previous === undefined || current === undefined) continue;
    const deltaMs = Math.max(1, frames[index].timestampMs - frames[index - 1].timestampMs);
    const velocity = ((previous - current) * 1000) / deltaMs;
    if (velocity > 0.025) return index - 1;
  }
  return loadIndex;
}

function findPeakIndex(frames: PoseFrame[], loadIndex: number) {
  let peakIndex = loadIndex;
  let smallestY = hipCenter(frames[loadIndex])?.y ?? Number.POSITIVE_INFINITY;
  for (let index = loadIndex; index < frames.length; index += 1) {
    const y = hipCenter(frames[index])?.y;
    if (y !== undefined && y < smallestY) {
      smallestY = y;
      peakIndex = index;
    }
  }
  return peakIndex;
}

function findLandingIndex(
  frames: PoseFrame[],
  releaseIndex: number,
  loadIndex: number,
  peakIndex: number,
) {
  const loadY = hipCenter(frames[loadIndex])?.y;
  if (loadY === undefined) return Math.min(frames.length - 1, releaseIndex + 1);
  const startTimestamp = frames[releaseIndex].timestampMs + 140;
  for (let index = Math.max(peakIndex + 1, releaseIndex + 1); index < frames.length; index += 1) {
    const hipY = hipCenter(frames[index])?.y;
    if (
      frames[index].timestampMs >= startTimestamp &&
      hipY !== undefined &&
      hipY >= loadY - 0.035
    ) {
      return index;
    }
  }
  return Math.min(frames.length - 1, peakIndex + Math.max(1, releaseIndex - loadIndex));
}

function baseWidth(frame: PoseFrame) {
  const leftFoot = midpoint(
    point(frame, LANDMARK.leftHeel),
    point(frame, LANDMARK.leftFootIndex),
  ) ?? point(frame, LANDMARK.leftAnkle);
  const rightFoot = midpoint(
    point(frame, LANDMARK.rightHeel),
    point(frame, LANDMARK.rightFootIndex),
  ) ?? point(frame, LANDMARK.rightAnkle);
  return distance(leftFoot, rightFoot);
}

function shoulderWidth(frame: PoseFrame) {
  return distance(
    point(frame, LANDMARK.leftShoulder),
    point(frame, LANDMARK.rightShoulder),
  );
}

function ratio(numerator?: number, denominator?: number) {
  if (numerator === undefined || denominator === undefined || denominator < EPSILON) {
    return undefined;
  }
  return numerator / denominator;
}

function torsoLean(frame: PoseFrame) {
  const shoulders = shoulderCenter(frame);
  const hips = hipCenter(frame);
  if (!shoulders || !hips) return undefined;
  return (Math.atan2(Math.abs(shoulders.x - hips.x), Math.abs(hips.y - shoulders.y)) * 180) / Math.PI;
}

function shoulderTilt(frame: PoseFrame) {
  const left = point(frame, LANDMARK.leftShoulder);
  const right = point(frame, LANDMARK.rightShoulder);
  if (!left || !right) return undefined;
  return (Math.atan2(Math.abs(left.y - right.y), Math.abs(left.x - right.x)) * 180) / Math.PI;
}

function bodyHeight(frame: PoseFrame) {
  const ankles = midpoint(
    point(frame, LANDMARK.leftAnkle),
    point(frame, LANDMARK.rightAnkle),
  );
  return distance(point(frame, LANDMARK.nose), ankles);
}

function confidenceForFrames(frames: PoseFrame[], side: "left" | "right") {
  const indices = sideIndices(side);
  const visibleFrames = frames.filter((frame) => frame.landmarks.length >= 29).length;
  const keyPointVisibility = average(
    frames.flatMap((frame) =>
      Object.values(indices).map((index) => frame.landmarks[index]?.visibility ?? 0),
    ),
  );
  return Math.max(
    0,
    Math.min(1, (visibleFrames / Math.max(1, frames.length)) * 0.55 + (keyPointVisibility ?? 0) * 0.45),
  );
}

function metricValues(shots: ShotRecord[], key: keyof ShotMetrics) {
  return shots
    .map((shot) => shot.metrics[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

export function calculateConsistency(
  metrics: ShotMetrics,
  history: ShotRecord[],
) {
  const madeShots = history.filter((shot) => shot.result === "made").slice(0, 30);
  if (madeShots.length < 3) return undefined;
  const deviations: number[] = [];
  for (const { key } of METRIC_DEFINITIONS) {
    const current = metrics[key];
    if (typeof current !== "number") continue;
    const baseline = metricValues(madeShots, key);
    if (baseline.length < 3) continue;
    const center = average(baseline);
    const spread = Math.max(standardDeviation(baseline), Math.abs(center ?? 1) * 0.035, 0.01);
    deviations.push(Math.abs(current - (center ?? current)) / spread);
  }
  if (!deviations.length) return undefined;
  const typicalDeviation = average(deviations) ?? 0;
  return Math.round(Math.max(0, Math.min(100, 100 - typicalDeviation * 17)));
}

export function analyzePoseFrames(
  inputFrames: PoseFrame[],
  options: AnalysisOptions = {},
): AnalysisResult {
  const frames = inputFrames
    .filter((frame) => frame.landmarks.length >= 29)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (frames.length < 3) {
    return {
      metrics: { confidence: 0 },
      summary: { frameCount: frames.length, modelVersion: "pose-landmarker-lite-f16-v1" },
    };
  }

  const dominantSide = selectDominantSide(frames, options.preferredSide);
  const indices = sideIndices(dominantSide);
  const releaseIndex = findReleaseIndex(frames, dominantSide, options.releaseFrameOverride);
  const loadIndex = findLoadIndex(frames, dominantSide, releaseIndex);
  const upwardIndex = findUpwardMotionIndex(frames, loadIndex, releaseIndex);
  const peakIndex = findPeakIndex(frames, loadIndex);
  const landingIndex = findLandingIndex(frames, releaseIndex, loadIndex, peakIndex);

  const release = frames[releaseIndex];
  const load = frames[loadIndex];
  const landing = frames[landingIndex];
  const loadShoulderWidth = shoulderWidth(load);
  const loadHip = hipCenter(load);
  const releaseHip = hipCenter(release);
  const landingHip = hipCenter(landing);
  const loadHeight = bodyHeight(load);
  const peakHip = hipCenter(frames[peakIndex]);

  const leftElbow = jointAngle(
    release,
    LANDMARK.leftShoulder,
    LANDMARK.leftElbow,
    LANDMARK.leftWrist,
  );
  const rightElbow = jointAngle(
    release,
    LANDMARK.rightShoulder,
    LANDMARK.rightElbow,
    LANDMARK.rightWrist,
  );
  const leftKnee = jointAngle(
    load,
    LANDMARK.leftHip,
    LANDMARK.leftKnee,
    LANDMARK.leftAnkle,
  );
  const rightKnee = jointAngle(
    load,
    LANDMARK.rightHip,
    LANDMARK.rightKnee,
    LANDMARK.rightAnkle,
  );

  const metrics: ShotMetrics = {
    releaseFrame: release.frameIndex,
    releaseTimingSeconds:
      Math.max(0, release.timestampMs - frames[upwardIndex].timestampMs) / 1000,
    elbowAngleDeg: dominantSide === "left" ? leftElbow : rightElbow,
    leftElbowAngleDeg: leftElbow,
    rightElbowAngleDeg: rightElbow,
    kneeAngleDeg: dominantSide === "left" ? leftKnee : rightKnee,
    leftKneeAngleDeg: leftKnee,
    rightKneeAngleDeg: rightKnee,
    hipAngleDeg: jointAngle(load, indices.shoulder, indices.hip, indices.knee),
    torsoLeanDeg: torsoLean(release),
    shoulderTiltDeg: shoulderTilt(release),
    baseWidthRatio: ratio(baseWidth(load), loadShoulderWidth),
    jumpHeightProxy:
      loadHip && peakHip ? ratio(Math.max(0, loadHip.y - peakHip.y), loadHeight) : undefined,
    jumpDrift:
      loadHip && releaseHip
        ? ratio(Math.abs(releaseHip.x - loadHip.x), loadShoulderWidth)
        : undefined,
    landingWidthRatio: ratio(baseWidth(landing), shoulderWidth(landing) ?? loadShoulderWidth),
    landingDisplacement:
      loadHip && landingHip
        ? ratio(Math.abs(landingHip.x - loadHip.x), loadShoulderWidth)
        : undefined,
    landingLateralDisplacement:
      loadHip && landingHip
        ? ratio(landingHip.x - loadHip.x, loadShoulderWidth)
        : undefined,
    dominantSide,
    confidence: confidenceForFrames(frames, dominantSide),
  };
  metrics.releaseConsistencyPct = calculateConsistency(metrics, options.history ?? []);

  const deltas = frames.slice(1).map((frame, index) => frame.timestampMs - frames[index].timestampMs);
  const medianDelta = median(deltas.filter((value) => value > 0));

  return {
    metrics,
    summary: {
      frameCount: frames.length,
      analyzedFps: medianDelta ? 1000 / medianDelta : undefined,
      releaseFrame: release.frameIndex,
      loadFrame: load.frameIndex,
      takeoffFrame: frames[upwardIndex].frameIndex,
      landingFrame: landing.frameIndex,
      modelVersion: "pose-landmarker-lite-f16-v1",
    },
  };
}

function aggregate(values: number[]): MetricAggregate {
  return {
    count: values.length,
    mean: values.length ? average(values) : undefined,
    standardDeviation: values.length > 1 ? standardDeviation(values) : undefined,
  };
}

export function compareOutcomes(
  shots: ShotRecord[],
  current?: ShotMetrics,
): OutcomeComparison[] {
  const made = shots.filter((shot) => shot.result === "made");
  const missed = shots.filter((shot) => shot.result === "missed");
  return METRIC_DEFINITIONS.map(({ key, label, unit }) => ({
    key,
    label,
    unit,
    made: aggregate(metricValues(made, key)),
    missed: aggregate(metricValues(missed, key)),
    current:
      typeof current?.[key] === "number" ? (current[key] as number) : undefined,
  }));
}

export function deriveCoachingInsight(shots: ShotRecord[]): CoachingInsight {
  const comparisons = compareOutcomes(shots);
  const eligible = comparisons
    .filter(
      (comparison) =>
        comparison.made.count >= 3 &&
        comparison.missed.count >= 3 &&
        comparison.made.mean !== undefined &&
        comparison.missed.mean !== undefined,
    )
    .map((comparison) => {
      const pooledSpread = Math.max(
        average([
          comparison.made.standardDeviation,
          comparison.missed.standardDeviation,
        ]) ?? 0,
        Math.abs(comparison.made.mean ?? 1) * 0.04,
        0.01,
      );
      return {
        comparison,
        strength:
          Math.abs((comparison.missed.mean ?? 0) - (comparison.made.mean ?? 0)) /
          pooledSpread,
      };
    })
    .sort((a, b) => b.strength - a.strength);

  if (!eligible.length) {
    const remaining = Math.max(
      0,
      3 - Math.min(
        shots.filter((shot) => shot.result === "made").length,
        shots.filter((shot) => shot.result === "missed").length,
      ),
    );
    return {
      title: "Your personal pattern is still forming",
      detail: remaining
        ? `Log at least ${remaining} more make${remaining === 1 ? "" : "s"} and miss${remaining === 1 ? "" : "es"} to unlock a reliable comparison.`
        : "Keep recording from the same phone position so the comparison stays meaningful.",
    };
  }

  const strongest = eligible[0];
  const { comparison } = strongest;
  const direction =
    (comparison.missed.mean ?? 0) > (comparison.made.mean ?? 0) ? "higher" : "lower";
  return {
    title: `${comparison.label} separates your makes most`,
    detail: `Your misses run ${direction} here than your makes. Treat this as a personal correlation, then test it over the next session.`,
    metric: comparison.key,
    strength: strongest.strength,
  };
}

export function roundMetric(value: number | undefined, digits = 1) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

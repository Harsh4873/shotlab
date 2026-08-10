import { describe, expect, it } from "vitest";

import {
  analyzePoseFrames,
  angleBetween,
  calculateConsistency,
  compareOutcomes,
  deriveCoachingInsight,
  selectDominantSide,
} from "../app/lib/metrics";
import type { PoseFrame, ShotMetrics } from "../app/lib/types";
import {
  shotRecord,
  syntheticShotFrames,
  transformFrames,
} from "./helpers/shot-fixtures";

describe("angleBetween", () => {
  const vertex = { x: 0, y: 0, z: 0 };

  it("returns an exact right angle", () => {
    expect(
      angleBetween(
        { x: 1, y: 0, z: 0 },
        vertex,
        { x: 0, y: 1, z: 0 },
      ),
    ).toBeCloseTo(90, 10);
  });

  it("returns an exact straight angle", () => {
    expect(
      angleBetween(
        { x: -1, y: 0, z: 0 },
        vertex,
        { x: 1, y: 0, z: 0 },
      ),
    ).toBeCloseTo(180, 10);
  });

  it("returns a known 120-degree obtuse angle", () => {
    expect(
      angleBetween(
        { x: 1, y: 0, z: 0 },
        vertex,
        { x: -0.5, y: Math.sqrt(3) / 2, z: 0 },
      ),
    ).toBeCloseTo(120, 10);
  });

  it("rejects a zero-length vector", () => {
    expect(angleBetween(vertex, vertex, { x: 1, y: 0, z: 0 })).toBeUndefined();
  });
});

describe("selectDominantSide", () => {
  it("uses median key-landmark visibility rather than a single outlier frame", () => {
    const frames = syntheticShotFrames().slice(0, 3);
    const leftIndices = [11, 13, 15, 23, 25, 27];
    const rightIndices = [12, 14, 16, 24, 26, 28];
    const visibilityPairs = [
      { left: 0.92, right: 0.7 },
      { left: 0.94, right: 0.7 },
      { left: 0.05, right: 1 },
    ];

    const adjusted: PoseFrame[] = frames.map((frame, frameIndex) => ({
      ...frame,
      landmarks: frame.landmarks.map((point) => {
        if (leftIndices.includes(point.index)) {
          return { ...point, visibility: visibilityPairs[frameIndex].left };
        }
        if (rightIndices.includes(point.index)) {
          return { ...point, visibility: visibilityPairs[frameIndex].right };
        }
        return point;
      }),
    }));

    expect(selectDominantSide(adjusted)).toBe("left");
    expect(selectDominantSide(adjusted, "right")).toBe("right");
  });
});

describe("analyzePoseFrames", () => {
  it("finds the synthetic shot phases and normalized metrics", () => {
    const result = analyzePoseFrames(syntheticShotFrames());

    expect(result.summary.frameCount).toBe(8);
    expect(result.summary.analyzedFps).toBeCloseTo(10, 10);
    expect(result.summary.releaseFrame).toBe(4);
    expect(result.summary.loadFrame).toBe(1);
    expect(result.summary.takeoffFrame).toBe(1);
    expect(result.summary.landingFrame).toBe(7);

    expect(result.metrics.dominantSide).toBe("right");
    expect(result.metrics.releaseFrame).toBe(4);
    expect(result.metrics.releaseTimingSeconds).toBeCloseTo(0.3, 10);
    expect(result.metrics.kneeAngleDeg).toBeCloseTo(90, 10);
    expect(result.metrics.baseWidthRatio).toBeCloseTo(1.2, 10);
    expect(result.metrics.jumpDrift).toBeCloseTo(0.2, 10);
    expect(result.metrics.landingDisplacement).toBeCloseTo(0.1, 10);
    expect(result.metrics.landingLateralDisplacement).toBeCloseTo(0.1, 10);
    expect(result.metrics.confidence).toBeGreaterThan(0.95);
  });

  it("keeps geometric metrics invariant under translation and uniform scale", () => {
    const frames = syntheticShotFrames();
    const baseline = analyzePoseFrames(frames);
    const transformed = analyzePoseFrames(
      transformFrames(frames, 1.75, { x: -0.31, y: 0.42, z: 0.18 }),
    );
    const invariantMetrics: Array<keyof ShotMetrics> = [
      "releaseTimingSeconds",
      "elbowAngleDeg",
      "kneeAngleDeg",
      "hipAngleDeg",
      "torsoLeanDeg",
      "shoulderTiltDeg",
      "baseWidthRatio",
      "jumpHeightProxy",
      "jumpDrift",
      "landingWidthRatio",
      "landingDisplacement",
      "landingLateralDisplacement",
      "confidence",
    ];

    expect(transformed.summary.releaseFrame).toBe(baseline.summary.releaseFrame);
    expect(transformed.summary.loadFrame).toBe(baseline.summary.loadFrame);
    expect(transformed.summary.takeoffFrame).toBe(baseline.summary.takeoffFrame);
    expect(transformed.summary.landingFrame).toBe(baseline.summary.landingFrame);

    for (const key of invariantMetrics) {
      expect(transformed.metrics[key], key).toBeCloseTo(
        baseline.metrics[key] as number,
        9,
      );
    }
  });
});

describe("calculateConsistency", () => {
  const baselineHistory = [158, 160, 162].map((elbowAngleDeg, index) =>
    shotRecord(`made-${index}`, "made", { elbowAngleDeg }),
  );

  it("requires at least three made shots", () => {
    expect(
      calculateConsistency({ elbowAngleDeg: 160 }, baselineHistory.slice(0, 2)),
    ).toBeUndefined();
  });

  it("scores a shot at its personal baseline above an outlier", () => {
    const typical = calculateConsistency(
      { elbowAngleDeg: 160 },
      baselineHistory,
    );
    const outlier = calculateConsistency(
      { elbowAngleDeg: 180 },
      baselineHistory,
    );

    expect(typical).toBe(100);
    expect(outlier).toBeTypeOf("number");
    expect(outlier as number).toBeLessThan(typical as number);
  });
});

describe("compareOutcomes", () => {
  it("separates made and missed aggregates and includes the current shot", () => {
    const shots = [
      shotRecord("m1", "made", { elbowAngleDeg: 160 }),
      shotRecord("m2", "made", { elbowAngleDeg: 164 }),
      shotRecord("x1", "missed", { elbowAngleDeg: 150 }),
      shotRecord("x2", "missed", { elbowAngleDeg: 154 }),
      shotRecord("u1", "unknown", { elbowAngleDeg: 999 }),
    ];
    const elbow = compareOutcomes(shots, { elbowAngleDeg: 161 }).find(
      (comparison) => comparison.key === "elbowAngleDeg",
    );

    expect(elbow).toBeDefined();
    expect(elbow?.made).toMatchObject({ count: 2, mean: 162 });
    expect(elbow?.made.standardDeviation).toBeCloseTo(2, 10);
    expect(elbow?.missed).toMatchObject({ count: 2, mean: 152 });
    expect(elbow?.missed.standardDeviation).toBeCloseTo(2, 10);
    expect(elbow?.current).toBe(161);
  });
});

describe("deriveCoachingInsight", () => {
  function outcomeShots(count: number) {
    return [
      ...Array.from({ length: count }, (_, index) =>
        shotRecord(`made-${index}`, "made", { elbowAngleDeg: 160 + index }),
      ),
      ...Array.from({ length: count }, (_, index) =>
        shotRecord(`missed-${index}`, "missed", { elbowAngleDeg: 145 + index * 2 }),
      ),
    ];
  }

  it("does not claim a coaching pattern below three makes and three misses", () => {
    const insight = deriveCoachingInsight(outcomeShots(2));

    expect(insight.metric).toBeUndefined();
    expect(insight.title).toBe("Your personal pattern is still forming");
    expect(insight.detail).toContain("1 more make and miss");
  });

  it("unlocks the strongest personal comparison at the sample threshold", () => {
    const insight = deriveCoachingInsight(outcomeShots(3));

    expect(insight.metric).toBe("elbowAngleDeg");
    expect(insight.strength).toBeGreaterThan(0);
    expect(insight.title).toContain("Release elbow");
    expect(insight.detail).toContain("personal correlation");
  });
});

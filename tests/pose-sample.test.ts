import { describe, expect, it } from "vitest";

import { MAX_ANALYSIS_CLIP_SECONDS, planSampleTimes } from "../app/lib/pose-engine";

describe("planSampleTimes", () => {
  it("keeps a 20 second clip inside the frame cap", () => {
    const planned = planSampleTimes(20, 30, 600);
    expect(planned.sampledFps).toBeCloseTo(30, 5);
    expect(planned.sampleTimes.length).toBeLessThanOrEqual(600);
    expect(planned.sampleTimes.length).toBeGreaterThan(500);
    expect(planned.sampleTimes[0]).toBe(0);
    expect(planned.sampleTimes.at(-1)).toBeGreaterThan(19);
  });

  it("lowers the sample rate so a 60 second clip still fits", () => {
    const planned = planSampleTimes(60, 30, 600);
    expect(planned.sampledFps).toBeCloseTo(10, 5);
    expect(planned.sampleTimes.length).toBeLessThanOrEqual(600);
    expect(planned.sampleTimes.at(-1)).toBeGreaterThan(59);
  });

  it("keeps the requested rate for a short clip", () => {
    const planned = planSampleTimes(2, 30, 600);
    expect(planned.sampledFps).toBeCloseTo(30, 5);
    expect(planned.sampleTimes.length).toBeGreaterThanOrEqual(60);
    expect(planned.sampleTimes.length).toBeLessThanOrEqual(62);
  });

  it("refuses a clip past the one-shot limit before sampling it", () => {
    expect(() => planSampleTimes(MAX_ANALYSIS_CLIP_SECONDS + 0.01, 30, 600)).toThrow(/60 seconds/);
    expect(() => planSampleTimes(180, 4, 600)).toThrow(/60 seconds/);
  });
});

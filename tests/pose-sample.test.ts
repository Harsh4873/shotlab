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

  it("drops samples that round to the same millisecond", () => {
    const planned = planSampleTimes(0.502, 30, 600);
    const stamps = planned.sampleTimes.map((seconds) => Math.round(seconds * 1000));
    expect(stamps.at(-1)).toBe(500);
    for (let index = 1; index < stamps.length; index += 1) {
      expect(stamps[index]).toBeGreaterThan(stamps[index - 1]);
    }

    for (const fps of [10, 15, 20, 25, 30]) {
      for (let durationMs = 500; durationMs <= 60000; durationMs += 250) {
        const rounded = planSampleTimes(durationMs / 1000, fps, 600).sampleTimes
          .map((seconds) => Math.round(seconds * 1000));
        const increasing = rounded.every((stamp, index) => index === 0 || stamp > rounded[index - 1]);
        expect(increasing, `${fps} fps at ${durationMs} ms`).toBe(true);
      }
    }
  });
});

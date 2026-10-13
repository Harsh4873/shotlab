import { describe, expect, it } from "vitest";

import { containedObjectRect } from "../app/lib/frame-rect";

describe("containedObjectRect", () => {
  it("pillarboxes a portrait frame inside a 16:9 stage", () => {
    const rect = containedObjectRect(1600, 900, 1080, 1920);
    expect(rect.y).toBeCloseTo(0, 5);
    expect(rect.height).toBeCloseTo(900, 5);
    expect(rect.width).toBeCloseTo(506.25, 5);
    expect(rect.x).toBeCloseTo(546.875, 5);
    expect(rect.x).toBeGreaterThan(100);
    expect(rect.x + rect.width).toBeLessThan(1500);
  });

  it("pillarboxes a 4:3 frame by a smaller amount", () => {
    const rect = containedObjectRect(1600, 900, 1440, 1080);
    expect(rect.height).toBeCloseTo(900, 5);
    expect(rect.width).toBeCloseTo(1200, 5);
    expect(rect.x).toBeCloseTo(200, 5);
    expect(rect.y).toBeCloseTo(0, 5);
  });

  it("fills a matching 16:9 frame", () => {
    const rect = containedObjectRect(1600, 900, 1920, 1080);
    expect(rect).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
  });

  it("uses the full stage until the video dimensions are known", () => {
    expect(containedObjectRect(640, 360, 0, 0)).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });
});

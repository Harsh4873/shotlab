import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  resolveTheme,
} from "../app/lib/theme";

function stubThemeEnvironment(saved: string | null, prefersLight: boolean) {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => saved),
    setItem: vi.fn(),
  });
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: prefersLight,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initial theme resolution", () => {
  it("uses the OS light preference when the visitor has no saved choice", () => {
    stubThemeEnvironment(null, true);
    expect(resolveTheme()).toBe("light");
  });

  it("lets an explicit saved choice outrank the OS", () => {
    stubThemeEnvironment("dark", true);
    expect(resolveTheme()).toBe("dark");
  });

  it("uses the shared harsh.bet key in the pre-paint resolver", () => {
    const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
    expect(THEME_STORAGE_KEY).toBe("harsh-theme");
    expect(THEME_INIT_SCRIPT).toContain("prefers-color-scheme: light");
    expect(THEME_INIT_SCRIPT).toContain('s==="light"||s==="dark"');
    expect(layout).toContain("<script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />");
  });
});

describe("narrow hero containment", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const tabletStart = css.indexOf("@media (max-width: 900px)");
  const mobileStart = css.indexOf("@media (max-width: 680px)");
  const mobileEnd = css.indexOf("@media (max-width: 390px)", mobileStart);
  const tablet = css.slice(tabletStart, mobileStart);
  const mobile = css.slice(mobileStart, mobileEnd);

  function rule(block: string, selector: string): string {
    const start = block.indexOf(selector);
    const end = block.indexOf("}", start);
    expect(start, `${selector} must have a narrow-screen override`).toBeGreaterThanOrEqual(0);
    return block.slice(start, end + 1);
  }

  function dimension(block: string, property: string, unit: "px" | "%"): number {
    const match = new RegExp(`${property}:\\s*(-?\\d+(?:\\.\\d+)?)(${unit.replace("%", "\\%")});`).exec(block);
    expect(match, `${property} must be expressed in ${unit}`).not.toBeNull();
    return Number(match?.[1]);
  }

  function rotation(block: string): number {
    const match = /rotate\((-?\d+(?:\.\d+)?)deg\)/.exec(block);
    expect(match, "the decoration must declare its rotation").not.toBeNull();
    return Number(match?.[1]);
  }

  function rotatedWidth(width: number, height: number, degrees: number): number {
    const radians = Math.abs(degrees) * Math.PI / 180;
    return Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians));
  }

  function horizontalContentPadding(): number {
    const content = rule(tablet, ".screen-content {");
    const match = /padding:\s*(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/.exec(content);
    expect(match, "mobile screen content must declare horizontal padding").not.toBeNull();
    return Number(match?.[2]);
  }

  it("keeps both rotated decorations inside 320px, 390px, and 680px viewports", () => {
    expect(css).toMatch(/\*\s*{\s*box-sizing:\s*border-box;/);

    const padding = horizontalContentPadding();
    const release = rule(mobile, ".hero-release-card {");
    const releaseRight = dimension(release, "right", "px");
    const releaseWidth = dimension(release, "width", "px");
    const releaseHeight = dimension(release, "height", "px");
    const releaseRotation = rotation(release);
    expect(releaseWidth).toBeGreaterThan(0);
    expect(releaseHeight).toBeGreaterThan(0);

    const court = rule(mobile, ".hero-court-lines {");
    const courtLeft = dimension(court, "left", "%") / 100;
    const courtRight = dimension(court, "right", "%") / 100;
    const courtHeight = dimension(court, "height", "px");
    const courtRotation = rotation(court);
    expect(courtLeft).toBeGreaterThanOrEqual(0);
    expect(courtRight).toBeGreaterThanOrEqual(0);
    expect(courtLeft + courtRight).toBeLessThan(1);
    expect(courtHeight).toBeGreaterThan(0);

    for (const viewport of [320, 390, 680]) {
      const heroWidth = viewport - 2 * padding;

      // right positions the unrotated border box; rotation expands equally
      // around its centre, so use the rotated AABB's half-width for max-x.
      const releaseCentre = heroWidth - releaseRight - releaseWidth / 2;
      const releaseMaxX = padding + releaseCentre
        + rotatedWidth(releaseWidth, releaseHeight, releaseRotation) / 2;
      expect(releaseMaxX, `release card max-x at ${viewport}px`).toBeLessThanOrEqual(viewport);

      // The court has auto width resolved by its percentage left/right insets.
      const courtWidth = heroWidth * (1 - courtLeft - courtRight);
      const courtCentre = heroWidth * courtLeft + courtWidth / 2;
      const courtMaxX = padding + courtCentre
        + rotatedWidth(courtWidth, courtHeight, courtRotation) / 2;
      expect(courtMaxX, `court decoration max-x at ${viewport}px`).toBeLessThanOrEqual(viewport);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  antdTheme,
  colorSchemes,
  cssVariables,
  fontScaleFactor,
  layout,
  resolveTheme,
  type ColorTheme,
} from "../src/theme/tokens.js";

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/iu.exec(hex);
  if (match === null) {
    throw new Error(`${hex} is not a six-digit hex color`);
  }
  const digits = match[1] as string;
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(digits.slice(offset, offset + 2), 16),
  ) as [number, number, number];
  return (
    0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
  );
}

function contrast(foreground: string, background: string): number {
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

const themes: ColorTheme[] = ["light", "dark"];

describe("the design tokens", () => {
  it("carries #24's layout sizes", () => {
    expect(layout.railWidth).toBe(228);
    expect(layout.railCollapsedWidth).toBe(64);
    expect(layout.topBarHeight).toBe(68);
    expect(layout.contentMaxWidth).toBe(1620);
    expect(layout.explorerMinWidth).toBe(260);
    expect(layout.explorerMaxWidth).toBe(320);
    expect(layout.inspectorMinWidth).toBe(280);
    expect(layout.inspectorMaxWidth).toBe(320);
    expect(layout.paneStackBreakpoint).toBe(1180);
    expect(layout.railDrawerBreakpoint).toBe(1024);
  });

  it("uses #24's colors in both themes", () => {
    expect(colorSchemes.light).toMatchObject({
      background: "#ffffff",
      surface: "#eef1f5",
      text: "#101827",
      secondaryText: "#4d596b",
      mutedText: "#5f6b7c",
      border: "#e2e7ee",
      accent: "#255ed8",
      status: {
        success: { fill: "#16a34a" },
        warning: { fill: "#c47a06" },
        danger: { fill: "#dc2626" },
        info: { fill: "#3975e9" },
      },
    });
    expect(colorSchemes.dark).toMatchObject({
      background: "#151923",
      surface: "#10141c",
      text: "#e4e8ef",
      border: "#303846",
      accent: "#6e9fff",
      status: {
        success: { fill: "#73bf69" },
        warning: { fill: "#ff9830" },
        danger: { fill: "#f2495c" },
      },
    });
  });

  it("meets AA for text and status pills in both themes", () => {
    for (const theme of themes) {
      const scheme = colorSchemes[theme];
      for (const [name, foreground] of [
        ["text", scheme.text],
        ["secondary text", scheme.secondaryText],
        ["muted text", scheme.mutedText],
        ["accent", scheme.accent],
      ] as const) {
        for (const [surfaceName, background] of [
          ["background", scheme.background],
          ["surface", scheme.surface],
        ] as const) {
          expect(
            contrast(foreground, background),
            `${theme} ${name} on ${surfaceName}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(
        contrast(scheme.onAccent, scheme.accent),
        `${theme} text on accent`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(scheme.accent, scheme.accentSoft),
        `${theme} accent on the active stage`,
      ).toBeGreaterThanOrEqual(4.5);
      for (const tone of ["success", "warning", "danger", "info"] as const) {
        expect(
          contrast(scheme.status[tone].text, scheme.status[tone].soft),
          `${theme} ${tone} pill`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("exposes one set of CSS variables derived from the same colors", () => {
    const light = cssVariables("light");
    const dark = cssVariables("dark");

    expect(light["--badger-color-background"]).toBe("#ffffff");
    expect(dark["--badger-color-background"]).toBe("#151923");
    expect(light["--badger-color-accent"]).toBe(colorSchemes.light.accent);
    expect(dark["--badger-color-accent"]).toBe("#6e9fff");
    expect(light["--badger-color-on-accent"]).toBe("#ffffff");
    expect(light["--badger-color-scrim"]).toContain("rgb(16 24 39");
    expect(light["--badger-layout-scope-select-width"]).toBe("150px");
    expect(light["--badger-layout-rail-width"]).toBe("228px");
    expect(light["--badger-layout-top-bar-height"]).toBe("68px");
    expect(light["--badger-font-size-base"]).toBe("14px");
    expect(light["--badger-font-family"]).toContain("Segoe UI Variable");
    expect(light["--badger-radius-control"]).toBe("8px");
    for (const name of Object.keys(light)) {
      expect(name.startsWith("--badger-")).toBe(true);
    }
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
  });

  it("themes Ant Design from the same tokens", () => {
    const light = antdTheme("light");
    const dark = antdTheme("dark");

    expect(light.token?.colorPrimary).toBe("#255ed8");
    expect(light.token?.colorText).toBe("#101827");
    expect(light.token?.colorBgLayout).toBe("#ffffff");
    expect(light.token?.colorBorder).toBe("#e2e7ee");
    expect(light.token?.fontSize).toBe(14);
    expect(light.token?.borderRadius).toBe(8);
    expect(light.token?.fontFamily).toContain("Segoe UI Variable");

    expect(dark.token?.colorPrimary).toBe("#6e9fff");
    expect(dark.token?.colorText).toBe("#e4e8ef");
    expect(dark.token?.colorBgLayout).toBe("#151923");
    expect(dark.token?.colorBorder).toBe("#303846");
    expect(dark.token?.colorTextLightSolid).toBe("#0d1424");
  });

  it("clamps the font scale to the offered range", () => {
    expect(fontScaleFactor(100)).toBe(1);
    expect(fontScaleFactor(120)).toBe(1.2);
    expect(fontScaleFactor(50)).toBe(0.9);
    expect(fontScaleFactor(500)).toBe(1.5);
  });

  it("resolves a theme choice against the system preference", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });
});

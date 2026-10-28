import type { ThemeConfig } from "antd";
import type { ThemeChoice } from "../preferences/model.js";

export type ColorTheme = "light" | "dark";

export interface StatusColors {
  /** The strong color for borders, icons, and charts. */
  fill: string;
  /** A 10-12% tint of the fill over the theme's background. */
  soft: string;
  /** A text color that reaches AA on `soft`. */
  text: string;
}

export interface ColorScheme {
  background: string;
  surface: string;
  text: string;
  secondaryText: string;
  mutedText: string;
  border: string;
  accent: string;
  accentSoft: string;
  status: Record<"success" | "warning" | "danger" | "info", StatusColors>;
}

/**
 * The one place colors are defined. The CSS variables and the Ant Design
 * theme both read this object, so a change lands in both at once.
 */
export const colorSchemes: Readonly<Record<ColorTheme, ColorScheme>> = {
  light: {
    background: "#ffffff",
    surface: "#eef1f5",
    text: "#101827",
    secondaryText: "#4d596b",
    mutedText: "#5f6b7c",
    border: "#e2e7ee",
    accent: "#255ed8",
    accentSoft: "#e9effb",
    status: {
      success: { fill: "#16a34a", soft: "#e8f6ed", text: "#116b36" },
      warning: { fill: "#c47a06", soft: "#f9f2e6", text: "#8a5300" },
      danger: { fill: "#dc2626", soft: "#fce9e9", text: "#b91c1c" },
      info: { fill: "#3975e9", soft: "#ebf1fd", text: "#255ed8" },
    },
  },
  dark: {
    background: "#151923",
    surface: "#10141c",
    text: "#e4e8ef",
    secondaryText: "#aeb7c6",
    mutedText: "#939dad",
    border: "#303846",
    accent: "#6e9fff",
    accentSoft: "#1c2942",
    status: {
      success: { fill: "#73bf69", soft: "#1f2a2a", text: "#73bf69" },
      warning: { fill: "#ff9830", soft: "#2d2624", text: "#ff9830" },
      danger: { fill: "#f2495c", soft: "#2c1e29", text: "#ff8b95" },
      info: { fill: "#7aa2ff", soft: "#202739", text: "#7aa2ff" },
    },
  },
};

/** #24's layout: rail, top bar, content width, and pane stacking. */
export const layout = {
  railWidth: 228,
  railCollapsedWidth: 64,
  topBarHeight: 68,
  contentMaxWidth: 1620,
  explorerMinWidth: 260,
  explorerMaxWidth: 320,
  inspectorMinWidth: 280,
  inspectorMaxWidth: 320,
  paneStackBreakpoint: 1180,
  railDrawerBreakpoint: 1024,
  gutter: 16,
} as const;

/** Base 14px on the 13/14/16/20/24 scale; page titles at 26px. */
export const typeScale = {
  xs: 13,
  sm: 14,
  base: 14,
  md: 16,
  lg: 20,
  xl: 24,
  title: 26,
} as const;

export const radii = { control: 8, panel: 12, pill: 999 } as const;

export const FONT_FAMILY = [
  '"Segoe UI Variable"',
  '"Segoe UI"',
  "Inter",
  "-apple-system",
  '"SF Pro Text"',
  '"PingFang SC"',
  '"Microsoft YaHei"',
  "system-ui",
  "sans-serif",
].join(", ");

export const MIN_FONT_SCALE = 90;
export const MAX_FONT_SCALE = 150;

const MOTION_DURATION_MS = 160;

function statusVariables(
  prefix: string,
  status: StatusColors,
): Record<string, string> {
  return {
    [`--badger-color-${prefix}`]: status.fill,
    [`--badger-color-${prefix}-soft`]: status.soft,
    [`--badger-color-${prefix}-text`]: status.text,
  };
}

/** The CSS custom properties a document carries for one theme. */
export function cssVariables(theme: ColorTheme): Record<string, string> {
  const scheme = colorSchemes[theme];
  return {
    "--badger-color-background": scheme.background,
    "--badger-color-surface": scheme.surface,
    "--badger-color-text": scheme.text,
    "--badger-color-text-secondary": scheme.secondaryText,
    "--badger-color-text-muted": scheme.mutedText,
    "--badger-color-border": scheme.border,
    "--badger-color-accent": scheme.accent,
    "--badger-color-accent-soft": scheme.accentSoft,
    ...statusVariables("success", scheme.status.success),
    ...statusVariables("warning", scheme.status.warning),
    ...statusVariables("danger", scheme.status.danger),
    ...statusVariables("info", scheme.status.info),
    "--badger-layout-rail-width": `${layout.railWidth}px`,
    "--badger-layout-rail-collapsed-width": `${layout.railCollapsedWidth}px`,
    "--badger-layout-top-bar-height": `${layout.topBarHeight}px`,
    "--badger-layout-content-max-width": `${layout.contentMaxWidth}px`,
    "--badger-layout-explorer-min-width": `${layout.explorerMinWidth}px`,
    "--badger-layout-explorer-max-width": `${layout.explorerMaxWidth}px`,
    "--badger-layout-inspector-min-width": `${layout.inspectorMinWidth}px`,
    "--badger-layout-inspector-max-width": `${layout.inspectorMaxWidth}px`,
    "--badger-layout-pane-stack-breakpoint": `${layout.paneStackBreakpoint}px`,
    "--badger-layout-rail-drawer-breakpoint": `${layout.railDrawerBreakpoint}px`,
    "--badger-layout-gutter": `${layout.gutter}px`,
    "--badger-font-family": FONT_FAMILY,
    "--badger-font-size-xs": `${typeScale.xs}px`,
    "--badger-font-size-sm": `${typeScale.sm}px`,
    "--badger-font-size-base": `${typeScale.base}px`,
    "--badger-font-size-md": `${typeScale.md}px`,
    "--badger-font-size-lg": `${typeScale.lg}px`,
    "--badger-font-size-xl": `${typeScale.xl}px`,
    "--badger-font-size-title": `${typeScale.title}px`,
    "--badger-radius-control": `${radii.control}px`,
    "--badger-radius-panel": `${radii.panel}px`,
    "--badger-radius-pill": `${radii.pill}px`,
    "--badger-motion-duration": `${MOTION_DURATION_MS}ms`,
  };
}

/** Ant Design's theme, read from the same tokens as the CSS variables. */
export function antdTheme(theme: ColorTheme, fontScale = 1): ThemeConfig {
  const scheme = colorSchemes[theme];
  const container = theme === "dark" ? scheme.surface : scheme.background;
  const fontSize = Math.round(typeScale.base * fontScale);
  return {
    token: {
      colorPrimary: scheme.accent,
      colorInfo: scheme.status.info.fill,
      colorSuccess: scheme.status.success.fill,
      colorWarning: scheme.status.warning.fill,
      colorError: scheme.status.danger.fill,
      colorBgLayout: scheme.background,
      colorBgContainer: container,
      colorBgElevated: container,
      colorText: scheme.text,
      colorTextSecondary: scheme.secondaryText,
      colorTextTertiary: scheme.mutedText,
      colorTextPlaceholder: scheme.secondaryText,
      colorTextDisabled: scheme.mutedText,
      colorIcon: scheme.secondaryText,
      colorIconHover: scheme.text,
      colorBorder: scheme.border,
      colorBorderSecondary: scheme.border,
      colorFillAlter: scheme.surface,
      colorFillSecondary: scheme.surface,
      colorFillTertiary: scheme.surface,
      fontFamily: FONT_FAMILY,
      fontSize,
      borderRadius: radii.control,
      borderRadiusLG: radii.panel,
      controlHeight: 34,
      motionDurationMid: `${MOTION_DURATION_MS}ms`,
      wireframe: false,
    },
    components: {
      Layout: {
        headerHeight: layout.topBarHeight,
        headerBg: scheme.background,
        bodyBg: scheme.background,
        siderBg: scheme.surface,
      },
      Menu: {
        itemBorderRadius: radii.control,
        itemSelectedBg: scheme.accentSoft,
        itemSelectedColor: scheme.accent,
      },
      Card: {
        borderRadiusLG: radii.panel,
      },
    },
  };
}

/** The theme a document shows for a person's choice and its system. */
export function resolveTheme(
  choice: ThemeChoice,
  system: ColorTheme,
): ColorTheme {
  return choice === "system" ? system : choice;
}

/** The multiplier for a saved font scale, clamped to the offered range. */
export function fontScaleFactor(scale: number): number {
  const clamped = Math.min(
    MAX_FONT_SCALE,
    Math.max(MIN_FONT_SCALE, Number.isFinite(scale) ? scale : 100),
  );
  return clamped / 100;
}

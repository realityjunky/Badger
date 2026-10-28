import { cssVariables, type ColorTheme } from "./tokens.js";

/** Writes the theme's custom properties onto the document element. */
export function applyTheme(
  theme: ColorTheme,
  fontScale = 1,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset["theme"] = theme;
  root.style.colorScheme = theme;
  for (const [name, value] of Object.entries(cssVariables(theme))) {
    root.style.setProperty(name, value);
  }
  root.style.setProperty("--badger-font-scale", String(fontScale));
}

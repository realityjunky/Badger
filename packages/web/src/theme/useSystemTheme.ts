import { useEffect, useState } from "react";
import type { ColorTheme } from "./tokens.js";

function systemTheme(): ColorTheme {
  return typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Follows the operating system's light or dark preference as it changes. */
export function useSystemTheme(): ColorTheme {
  const [theme, setTheme] = useState<ColorTheme>(systemTheme);

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? "dark" : "light");
    };
    query.addEventListener("change", listener);
    setTheme(query.matches ? "dark" : "light");
    return () => query.removeEventListener("change", listener);
  }, []);

  return theme;
}

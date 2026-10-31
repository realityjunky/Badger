import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { readBasePath } from "./app/paths.js";
import { applyTheme } from "./theme/applyTheme.js";
import "./styles/global.css";

// Apply the system's theme before the first paint; the person's saved choice
// replaces it as soon as the service answers.
applyTheme(
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
);

const container = document.getElementById("root");
if (container === null) {
  throw new Error("The dashboard has no root element");
}

createRoot(container).render(
  <StrictMode>
    <App
      basePath={readBasePath(document)}
      demoMode={
        document
          .querySelector('meta[name="badger-demo"]')
          ?.getAttribute("content") === "true"
      }
    />
  </StrictMode>,
);

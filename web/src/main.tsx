/// <reference types="vite/client" />
import "@fontsource-variable/geist/wght.css";
import { createRoot } from "react-dom/client";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing root element");

// THROWAWAY: DEV-only fixture route must never initialize bridge/native consumers.
if (import.meta.env.DEV && new URLSearchParams(location.search).get("prototype") === "pi-composer") {
  void import("./pi-mode/prototype/PiComposerPrototype").then(({ PiComposerPrototype }) => {
    createRoot(root).render(<PiComposerPrototype />);
  });
} else {
  void import("./productionRoot").then(({ mountProduction }) => mountProduction(root));
}

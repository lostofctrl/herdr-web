import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { BridgeProvider } from "./bridge";
import { startNativeControls } from "./native";

export function mountProduction(root: HTMLElement) {
  startNativeControls();
  createRoot(root).render(
    <StrictMode>
      <BridgeProvider>
        <App />
      </BridgeProvider>
    </StrictMode>,
  );
}

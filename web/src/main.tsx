// SF Pro where the OS has it; Inter is the stand-in everywhere else.
import "@fontsource-variable/inter";
import "@fontsource-variable/geist-mono";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";

const el = document.getElementById("root");
if (!el) throw new Error("missing #root");
createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

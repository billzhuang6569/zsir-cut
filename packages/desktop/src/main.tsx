import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "virtual:tokens.css";
import "./shell.css";

declare global {
  interface Window {
    __ZCUT_HOST__?: { port: number; token: string };
  }
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App {...(window.__ZCUT_HOST__ ? { config: window.__ZCUT_HOST__ } : {})} />);

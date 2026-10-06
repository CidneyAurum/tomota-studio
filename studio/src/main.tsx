import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "./router";
import { App } from "./App";
import { DesktopBar } from "./desktop";
import "./styles.css";

if (window.tomotaDesktop) document.documentElement.classList.add('desktop-mode');

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <DesktopBar />
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);

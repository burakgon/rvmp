import React from "react";
import { createRoot } from "react-dom/client";
import "../theme.css";
import "./showcase.css";
import { Showcase } from "./Showcase";

createRoot(document.getElementById("root")!).render(<Showcase />);

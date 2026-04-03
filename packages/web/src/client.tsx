import { StartClient } from "@tanstack/react-start/client";
import { hydrateRoot } from "react-dom/client";
import "./router";
import { installBrowserLogForwarder } from "./lib/browser-log-forwarder";

installBrowserLogForwarder();

hydrateRoot(document, <StartClient />);

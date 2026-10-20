import {StartClient} from "@tanstack/react-start/client";
import {hydrateRoot} from "react-dom/client";
// Side-effect import: registers the router types and persisted-query setup before hydration
// eslint-disable-next-line import/no-unassigned-import
import "./router";
import {installBrowserLogForwarder} from "./lib/browser-log-forwarder";

installBrowserLogForwarder();

hydrateRoot(document, <StartClient />);

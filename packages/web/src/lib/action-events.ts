import * as events from "node:events";
import type {ActionEvent} from "./server-events-schema.js";

export type {ActionEvent};

export const actionEmitter = new events.EventEmitter();
actionEmitter.setMaxListeners(100);

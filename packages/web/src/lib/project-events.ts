import { EventEmitter } from "node:events";

export const projectEmitter = new EventEmitter();
projectEmitter.setMaxListeners(100);

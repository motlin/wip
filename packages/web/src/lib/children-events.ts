import { EventEmitter } from "node:events";

export const childrenEmitter = new EventEmitter();
childrenEmitter.setMaxListeners(100);

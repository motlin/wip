import { EventEmitter } from "node:events";

export const todoEmitter = new EventEmitter();
todoEmitter.setMaxListeners(100);

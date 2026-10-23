import {EventEmitter} from "node:events";

/** Emits "issues" and "projectItems" with the full refreshed list after a background GitHub refresh. */
export const githubEmitter = new EventEmitter();
githubEmitter.setMaxListeners(100);

import type {ReadyBuffer} from "./ready-buffer.js";

/**
 * The ready buffer this process runs, held apart from ready-buffer-server.ts so server functions
 * can reach it without an import cycle; null when it is off or another wip process owns it.
 */
let instance: ReadyBuffer | null = null;

export function currentReadyBuffer(): ReadyBuffer | null {
	return instance;
}

export function setReadyBuffer(buffer: ReadyBuffer): void {
	instance = buffer;
}

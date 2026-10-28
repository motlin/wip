import {EventEmitter} from "node:events";

/**
 * Pull signals raised outside the ready buffer's own subscriptions. A plain emitter, so
 * producers (the On hold action) signal the buffer without importing its wiring. It also carries
 * the buffer's "state" (ReadyToLandState) to the SSE stream after every pull.
 */
export const readyBufferEmitter = new EventEmitter();
readyBufferEmitter.setMaxListeners(100);

export interface OnHoldSignal {
	project: string;
}

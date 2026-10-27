import {describe, expect, it} from "vite-plus/test";

import {getReadyBufferCapacity, getReadyBufferSize} from "./config.js";

describe("getReadyBufferSize", () => {
	it("defaults to 3 and reads readyBuffer.size, ignoring invalid values", () => {
		expect({
			unset: getReadyBufferSize({}),
			set: getReadyBufferSize({"readyBuffer.size": "5"}),
			zero: getReadyBufferSize({"readyBuffer.size": "0"}),
			junk: getReadyBufferSize({"readyBuffer.size": "abc"}),
		}).toStrictEqual({unset: 3, set: 5, zero: 3, junk: 3});
	});
});

describe("getReadyBufferCapacity", () => {
	it("reads readyBuffer.capacity, else the build class cap, else the default build cap", () => {
		expect({
			unset: getReadyBufferCapacity({}),
			buildCap: getReadyBufferCapacity({"workQueue.build": "4"}),
			set: getReadyBufferCapacity({"readyBuffer.capacity": "1", "workQueue.build": "4"}),
			junk: getReadyBufferCapacity({"readyBuffer.capacity": "-2"}),
		}).toStrictEqual({unset: 2, buildCap: 4, set: 1, junk: 2});
	});
});

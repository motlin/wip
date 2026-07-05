import {describe, expect, it} from "vitest";

import {contentTypeFor, resolveStaticPath} from "./serve.mjs";

const CLIENT_DIR = "/srv/app/dist/client";

describe("resolveStaticPath", () => {
	it("resolves a simple asset path inside the client dir", () => {
		expect(resolveStaticPath(CLIENT_DIR, "/assets/app.js")).toBe("/srv/app/dist/client/assets/app.js");
	});

	it("strips query strings", () => {
		expect(resolveStaticPath(CLIENT_DIR, "/assets/app.js?v=abc")).toBe("/srv/app/dist/client/assets/app.js");
	});

	it("rejects path traversal", () => {
		expect(resolveStaticPath(CLIENT_DIR, "/../../etc/passwd")).toBeNull();
		expect(resolveStaticPath(CLIENT_DIR, "/assets/../../secret")).toBeNull();
	});

	it("rejects the bare root path", () => {
		expect(resolveStaticPath(CLIENT_DIR, "/")).toBeNull();
	});

	it("decodes percent-encoded segments before resolving", () => {
		expect(resolveStaticPath(CLIENT_DIR, "/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
	});
});

describe("contentTypeFor", () => {
	it("maps common extensions", () => {
		expect(contentTypeFor("/a/b/app.js")).toBe("text/javascript; charset=utf-8");
		expect(contentTypeFor("/a/b/style.css")).toBe("text/css; charset=utf-8");
		expect(contentTypeFor("/a/b/index.html")).toBe("text/html; charset=utf-8");
		expect(contentTypeFor("/a/b/icon.svg")).toBe("image/svg+xml");
		expect(contentTypeFor("/a/b/font.woff2")).toBe("font/woff2");
	});

	it("falls back to octet-stream", () => {
		expect(contentTypeFor("/a/b/data.unknown")).toBe("application/octet-stream");
	});
});

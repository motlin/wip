import {describe, expect, it} from "vite-plus/test";

import {Route} from "./__root.js";

describe("root head", () => {
	it("links only same-origin resources so first paint never waits on a third-party round-trip", () => {
		const head = Route.options.head?.({} as never);
		const links = (head as {links: Array<{rel: string; href: string}>}).links;
		expect(
			links.map(({rel, href}) => ({
				rel,
				sameOrigin: new URL(href, "http://self.test/").origin === "http://self.test",
			})),
		).toEqual([
			{rel: "icon", sameOrigin: true},
			{rel: "stylesheet", sameOrigin: true},
		]);
	});
});

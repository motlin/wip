#!/usr/bin/env node

import {registerHooks} from "node:module";

// The workspace is ESM TypeScript with `.js` import specifiers (NodeNext style), and
// `@wip/shared` is published as raw `src`. Node strips types but does not remap a
// `.js` specifier to its `.ts` source, so resolve relative `.js` imports to `.ts`
// when the `.js` file does not exist. This lets the CLI run straight from source.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
			try {
				return nextResolve(specifier, context);
			} catch {
				return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			}
		}
		return nextResolve(specifier, context);
	},
});

const {execute} = await import("@oclif/core");

await execute({dir: import.meta.url});

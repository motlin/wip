/**
 * Production server for the WIP dashboard: a single node process serving
 * static assets from dist/client and routing everything else to the SSR
 * fetch handler in dist/server/server.js. Exists because `vp preview` runs a
 * per-core worker cluster (absurd for a single-user local dashboard) and the
 * build output itself exports a handler without a listener.
 *
 * Usage: node serve.mjs [--port 3456]
 */
import {createServer} from "node:http";
import {createReadStream, existsSync, statSync} from "node:fs";
import * as path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {Readable} from "node:stream";

const CONTENT_TYPES = new Map([
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".txt", "text/plain; charset=utf-8"],
	[".webp", "image/webp"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
]);

export function contentTypeFor(filePath) {
	return CONTENT_TYPES.get(path.extname(filePath)) ?? "application/octet-stream";
}

/**
 * Map a URL pathname to a file inside clientDir, or null when the path
 * escapes the client dir or is the root (which must go to SSR).
 */
export function resolveStaticPath(clientDir, urlPath) {
	const withoutQuery = urlPath.split("?")[0] ?? "";
	let decoded;
	try {
		decoded = decodeURIComponent(withoutQuery);
	} catch {
		return null;
	}
	if (decoded === "/" || decoded === "") return null;
	if (decoded.split("/").includes("..")) return null;
	const resolved = path.resolve(clientDir, `.${path.posix.normalize(decoded)}`);
	if (resolved === path.resolve(clientDir)) return null;
	if (!resolved.startsWith(`${path.resolve(clientDir)}${path.sep}`)) return null;
	return resolved;
}

function toWebRequest(nodeRequest, port) {
	const url = `http://localhost:${port}${nodeRequest.url}`;
	const headers = new Headers();
	for (const [name, value] of Object.entries(nodeRequest.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	const hasBody = nodeRequest.method !== "GET" && nodeRequest.method !== "HEAD";
	return new Request(url, {
		method: nodeRequest.method,
		headers,
		body: hasBody ? Readable.toWeb(nodeRequest) : undefined,
		duplex: hasBody ? "half" : undefined,
	});
}

async function writeWebResponse(webResponse, nodeResponse) {
	const headers = {};
	for (const [name, value] of webResponse.headers.entries()) {
		headers[name] = value;
	}
	nodeResponse.writeHead(webResponse.status, headers);
	if (!webResponse.body) {
		nodeResponse.end();
		return;
	}
	for await (const chunk of webResponse.body) {
		nodeResponse.write(chunk);
	}
	nodeResponse.end();
}

async function main() {
	const portFlagIndex = process.argv.indexOf("--port");
	const port = portFlagIndex === -1 ? 3456 : Number(process.argv[portFlagIndex + 1]);
	if (!Number.isInteger(port) || port <= 0) {
		console.error(`Invalid --port value: ${process.argv[portFlagIndex + 1]}`);
		process.exit(1);
	}

	const webDir = path.dirname(fileURLToPath(import.meta.url));
	const clientDir = path.join(webDir, "dist", "client");
	const serverEntry = path.join(webDir, "dist", "server", "server.js");
	if (!existsSync(serverEntry) || !existsSync(clientDir)) {
		console.error(`No production build under ${path.join(webDir, "dist")} — run \`just build\` first.`);
		process.exit(1);
	}

	const {default: ssr} = await import(pathToFileURL(serverEntry).href);

	const server = createServer((request, response) => {
		const handle = async () => {
			if (request.method === "GET" || request.method === "HEAD") {
				const staticPath = resolveStaticPath(clientDir, request.url ?? "/");
				if (staticPath && existsSync(staticPath) && statSync(staticPath).isFile()) {
					response.writeHead(200, {
						"Content-Type": contentTypeFor(staticPath),
						"Content-Length": statSync(staticPath).size,
						// Vite asset filenames are content-hashed, safe to cache hard
						"Cache-Control": staticPath.includes(`${path.sep}assets${path.sep}`)
							? "public, max-age=31536000, immutable"
							: "no-cache",
					});
					if (request.method === "HEAD") {
						response.end();
						return;
					}
					createReadStream(staticPath).pipe(response);
					return;
				}
			}

			const webResponse = await ssr.fetch(toWebRequest(request, port));
			await writeWebResponse(webResponse, response);
		};

		handle().catch((error) => {
			console.error("Request failed:", error);
			if (!response.headersSent) {
				response.writeHead(500, {"Content-Type": "text/plain; charset=utf-8"});
			}
			response.end("Internal Server Error");
		});
	});

	server.listen(port, () => {
		console.log(`WIP dashboard (production) on http://localhost:${port}/`);
	});
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
	await main();
}

import {describe, it, expect} from "vite-plus/test";
import * as http from "node:http";

describe("test network isolation (git-env-setup)", () =>
{
	it("rejects a fetch to a real host at once instead of reaching the network", async () =>
	{
		const started = Date.now();
		const outcome = await fetch(
			"https://api.github.com/graphql",
			{
				method: "POST",
				body: "{}",
			},
		).then(
			(response) => (
			{
				reached: response.status,
			}),
			(error: unknown) => (
			{
				rejected: error instanceof Error ? error.message : String(error),
			}),
		);

		expect(
			{
				outcome,
				instant: Date.now() - started < 1000,
			},
		).toStrictEqual(
			{
				outcome:
				{
					rejected:
						"Test fetch to https://api.github.com/graphql blocked: tests never reach the real network; replay a Polly recording or stub the client",
				},
				instant: true,
			},
		);
	});

	it("lets a fetch to a loopback server through", async () =>
	{
		const server = http.createServer((_request, response) =>
		{
			response.end("local");
		});
		await new Promise<void>((resolve) =>
		{
			server.listen(0, "127.0.0.1", resolve);
		});
		try
		{
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			const response = await fetch(`http://127.0.0.1:${port}/`);

			expect(await response.text()).toBe("local");
		}
		finally
		{
			server.close();
		}
	});
});

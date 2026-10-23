import {herdrRequest, type HerdrResult} from "./client.js";
import {resolveHerdrSocketPath} from "./socket-path.js";

const REQUEST_TIMEOUT_MS = 5000;

/** Focus an existing herdr pane. */
export async function focusHerdrPane(
	paneId: string,
	socketPath: string = resolveHerdrSocketPath(),
): Promise<HerdrResult<undefined>> {
	const response = await herdrRequest(
		{id: `wip:focus:${crypto.randomUUID().slice(0, 8)}`, method: "pane.focus", params: {pane_id: paneId}},
		REQUEST_TIMEOUT_MS,
		socketPath,
	);
	if (!response.ok) return response;
	return {ok: true, value: undefined};
}

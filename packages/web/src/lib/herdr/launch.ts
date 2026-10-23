import {z} from "zod";
import {herdrRequest, type HerdrResult} from "./client.js";
import {resolveHerdrSocketPath} from "./socket-path.js";

export interface HerdrLaunchRequest {
	cwd: string;
	label: string;
	command: string;
	focus: boolean;
}

export interface HerdrLaunchResult {
	tabId: string;
	paneId: string;
}

const REQUEST_TIMEOUT_MS = 5000;

const tabCreatedSchema = z.object({
	tab: z.object({tab_id: z.string()}),
	root_pane: z.object({pane_id: z.string()}),
});

const UNAVAILABLE_CODES = new Set(["connect-failed", "timeout", "closed"]);

function toFailure(response: {code: string; message: string}): HerdrResult<never> {
	if (UNAVAILABLE_CODES.has(response.code)) return {ok: false, code: "unavailable", message: response.message};
	return {ok: false, code: response.code, message: response.message};
}

/**
 * Open a labelled tab in `cwd` and type `command` into its shell. The command runs in the
 * tab's shell so the tab survives the command ending.
 */
export async function launchInHerdr(
	{cwd, label, command, focus}: HerdrLaunchRequest,
	socketPath: string = resolveHerdrSocketPath(),
): Promise<HerdrResult<HerdrLaunchResult>> {
	const id = `wip:launch:${crypto.randomUUID().slice(0, 8)}`;
	const send = async (method: string, params: object) =>
		herdrRequest({id: `${id}:${method}`, method, params}, REQUEST_TIMEOUT_MS, socketPath);

	const created = await send("tab.create", {cwd, label, focus});
	if (!created.ok) return toFailure(created);
	const tab = tabCreatedSchema.safeParse(created.value);
	if (!tab.success) return {ok: false, code: "bad-response", message: "herdr returned an invalid tab.create result"};
	const tabId = tab.data.tab.tab_id;
	const paneId = tab.data.root_pane.pane_id;

	const typed = await send("pane.send_text", {pane_id: paneId, text: command});
	if (!typed.ok) return toFailure(typed);
	const entered = await send("pane.send_keys", {pane_id: paneId, keys: ["enter"]});
	if (!entered.ok) return toFailure(entered);
	return {ok: true, value: {tabId, paneId}};
}

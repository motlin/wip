import {createFileRoute} from "@tanstack/react-router";
import {QueueTable} from "../../../components/queue-table.js";

export const Route = createFileRoute("/_dashboard/queue/table")({
	component: QueueTable,
});

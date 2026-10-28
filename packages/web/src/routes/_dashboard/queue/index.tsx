import {createFileRoute} from "@tanstack/react-router";
import {QueueCards} from "../../../components/queue-cards.js";

export const Route = createFileRoute("/_dashboard/queue/")({
	component: QueueCards,
});

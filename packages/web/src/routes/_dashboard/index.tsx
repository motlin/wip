import {createFileRoute, redirect} from "@tanstack/react-router";

export const Route = createFileRoute("/_dashboard/")({
	beforeLoad: () => {
		// oxlint-disable-next-line typescript/only-throw-error -- TanStack Router redirect() is thrown by design
		throw redirect({to: "/queue"});
	},
});

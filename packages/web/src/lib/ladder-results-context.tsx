import {createContext, useContext} from "react";
import {useQuery} from "@tanstack/react-query";
import type {LadderResult} from "@wip/shared";
import {ladderResultsQueryOptions} from "./queries.js";

const LadderResultsContext = createContext<readonly LadderResult[] | undefined>(undefined);

/**
 * One ladder-results subscription for every card below it. A useQuery per
 * card put one observer per card on the 5 s poll.
 */
export function LadderResultsProvider({children}: {children: React.ReactNode}) {
	const {data = []} = useQuery(ladderResultsQueryOptions());
	return <LadderResultsContext value={data}>{children}</LadderResultsContext>;
}

export function useLadderResults(): readonly LadderResult[] {
	const results = useContext(LadderResultsContext);
	if (results === undefined) throw new Error("useLadderResults must be used within LadderResultsProvider");
	return results;
}

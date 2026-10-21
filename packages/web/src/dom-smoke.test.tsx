// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from "vite-plus/test";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";

function Counter({onPress}: {onPress: () => void}) {
	return <button onClick={onPress}>press</button>;
}

describe("jsdom component testing", () => {
	afterEach(() => {
		cleanup();
	});

	it("runs the click handler", () => {
		const onPress = vi.fn<() => void>();
		render(<Counter onPress={onPress} />);
		fireEvent.click(screen.getByRole("button", {name: "press"}));
		expect(onPress).toHaveBeenCalledTimes(1);
	});
});

declare module 'ansi-to-html' {
	interface Options {
		/** The default foreground color used when reset color codes are encountered. */
		fg?: string;
		/** The default background color used when reset color codes are encountered. */
		bg?: string;
		/** Generate an anchor tag for URLs in the text. */
		newline?: boolean;
		/** Escape XML entities. */
		escapeXML?: boolean;
		/** Enable streaming mode. */
		stream?: boolean;
		/** Map of color palette. */
		colors?: string[] | Record<number, string>;
	}

	class AnsiToHtml {
		constructor(options?: Options);
		toHtml(input: string): string;
	}

	export default AnsiToHtml;
}

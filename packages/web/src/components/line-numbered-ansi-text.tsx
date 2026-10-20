import {useMemo} from "react";
import AnsiToHtml from "ansi-to-html";

const converter = new AnsiToHtml({
	escapeXML: true,
});

interface LineNumberedAnsiTextProps {
	text: string;
	className?: string;
}

export function LineNumberedAnsiText({text, className}: LineNumberedAnsiTextProps) {
	const lines = useMemo(() => {
		const raw = text.split("\n");
		return raw.map((line, index) => ({lineNumber: index + 1, html: converter.toHtml(line)}));
	}, [text]);

	const gutterWidth = String(lines.length).length;

	return (
		<pre className={className}>
			{lines.map(({lineNumber, html}) => (
				<div key={lineNumber} className="flex">
					<span
						className="mr-4 inline-block select-none text-right text-text-500"
						style={{minWidth: `${gutterWidth}ch`}}
					>
						{lineNumber}
					</span>
					<span dangerouslySetInnerHTML={{__html: html || "\u200b"}} />
				</div>
			))}
		</pre>
	);
}

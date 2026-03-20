import {useMemo} from 'react';
import AnsiToHtml from 'ansi-to-html';

const converter = new AnsiToHtml({
	escapeXML: true,
});

interface AnsiTextProps {
	text: string;
	className?: string;
}

export function AnsiText({text, className}: AnsiTextProps) {
	const html = useMemo(() => converter.toHtml(text), [text]);

	return (
		<pre
			className={className}
			dangerouslySetInnerHTML={{__html: html}}
		/>
	);
}

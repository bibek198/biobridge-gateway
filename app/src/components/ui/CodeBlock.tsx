import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

// JSON with syntax highlighting from a tiny tokenizer (no highlighter dependency).

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

function highlight(text: string) {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [all, str, colon, num, lit, punct] = m;
    if (str !== undefined) {
      out.push(
        <span key={i++} className={colon ? "tok-key" : "tok-string"}>
          {str}
        </span>
      );
      if (colon) out.push(<span key={i++} className="tok-punct">{colon}</span>);
    } else if (num !== undefined) out.push(<span key={i++} className="tok-number">{num}</span>);
    else if (lit !== undefined) out.push(<span key={i++} className="tok-literal">{lit}</span>);
    else if (punct !== undefined) out.push(<span key={i++} className="tok-punct">{punct}</span>);
    else out.push(all);
    last = m.index + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function CodeBlock({ value, json = true, wrap, maxHeight }: { value: string; json?: boolean; wrap?: boolean; maxHeight?: number }) {
  const nodes = useMemo(() => (json ? highlight(value) : value), [value, json]);
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        className="btn small ghost"
        style={{ position: "absolute", top: 6, right: 6 }}
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
        aria-label="Copy to clipboard"
      >
        <Icon name={copied ? "check" : "copy"} size={13} />
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className={wrap ? "code wrap" : "code"} style={maxHeight ? { maxHeight } : undefined}>
        {nodes}
      </pre>
    </div>
  );
}

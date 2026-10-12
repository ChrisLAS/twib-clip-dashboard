// Language-neutral policy and synthetic vectors: docs/number-one-parity/secret-policy.md.
// Explicit code points avoid Python/JavaScript Unicode boundary/whitespace drift.
const whitespace =
  "\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const ws = `[${whitespace}]`;
const value = `[^${whitespace}]+`;
const recognizableSecret = new RegExp(
  `(?<![a-z0-9_])(?:` +
    `(?:bearer|basic)${ws}+${value}|` +
    `(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|authorization|api[_-]?key|signature)["']?${ws}*[:=]${ws}*(?:["']?(?:bearer|basic)${ws}+${value}|${value})|` +
    `eyj[a-z0-9_-]+\\.[a-z0-9_-]+\\.[a-z0-9_-]+|` +
    `gh[pousr]_[a-z0-9_]+|sk-[a-z0-9_-]{16,})`,
  "g",
);
function folded(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
export function containsRecognizableSecret(value: string): boolean {
  recognizableSecret.lastIndex = 0;
  return recognizableSecret.test(folded(value));
}
// Conformance reference for the producer redactor. Receiver ingestion rejects
// secret-bearing input; it never silently substitutes this redacted output.
export function redactRecognizableSecrets(value: string): string {
  recognizableSecret.lastIndex = 0;
  let output = "";
  let end = 0;
  for (const match of folded(value).matchAll(recognizableSecret)) {
    output += value.slice(end, match.index) + "[redacted-secret]";
    end = match.index + match[0].length;
  }
  return output + value.slice(end);
}

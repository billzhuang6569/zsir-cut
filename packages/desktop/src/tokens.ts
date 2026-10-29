import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";

export function tokenCss(): string {
  const tokens = JSON.parse(readFileSync(new NodeURL("../../../design/tokens.json", import.meta.url), "utf8"));
  const variables: string[] = [];
  for (const token of tokens.color.tokens) variables.push(`--${token.name}: ${token.value.dark};`);
  for (const group of [tokens.spacing, tokens.radius, tokens.size]) {
    for (const token of group.tokens) variables.push(`--${token.name}: ${token.value};`);
  }
  for (const [name, value] of Object.entries(tokens.type.families)) variables.push(`--font-${name}: ${value};`);
  for (const group of tokens.type.groups) {
    for (const style of group.styles) {
      variables.push(
        `--${style.name}-size: ${style.fontSize};`,
        `--${style.name}-line: ${style.lineHeight};`,
        `--${style.name}-weight: ${style.fontWeight};`,
      );
    }
  }
  return `:root {\n  ${variables.join("\n  ")}\n}\n`;
}

import { Editor, Notice } from "obsidian";

const fenceStart = (line: string) => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const startsBlock = (line: string) => !!fenceStart(line) || /^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s)/.test(line);

export function insertGenerator(editor: Editor): void {
  const cursor = editor.getCursor();
  const last = editor.lineCount() - 1;
  let end = cursor.line;
  for (let line = 0; line <= cursor.line; line++) {
    const opening = fenceStart(editor.getLine(line));
    if (!opening || (opening[1][0] === "`" && opening[2].includes("`"))) continue;
    const closing = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[\\t ]*$`);
    let close = line + 1;
    while (close <= last && !closing.test(editor.getLine(close))) close++;
    if (cursor.line <= Math.min(close, last)) {
      if (close > last) {
        new Notice("Закройте текущий блок кода перед вставкой генератора.");
        return;
      }
      end = close;
      break;
    }
    line = close;
  }
  if (end === cursor.line && editor.getLine(end).trim() && !fenceStart(editor.getLine(end))) {
    while (end < last && editor.getLine(end + 1).trim() && !startsBlock(editor.getLine(end + 1))) end++;
  }
  const empty = !editor.getLine(end).trim();
  const position = { line: end, ch: empty ? 0 : editor.getLine(end).length };
  editor.replaceRange(`${empty ? "" : "\n"}\`\`\`cloom\n\`\`\`\n`, position);
  editor.setCursor({ line: end + (empty ? 2 : 3), ch: 0 });
}

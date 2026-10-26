export const lockedNotice = "Карточка заблокирована. Для редактирования и перегенерации откройте замок.";

export function isCardLocked(source: string): boolean {
  return /^[\t ]*locked[\t ]*:[\t ]*true[\t ]*\r?$/m.test(source);
}

export function setCardLocked(source: string, locked: boolean): string {
  const clean = source.replace(/^[\t ]*locked[\t ]*:[^\r\n]*(?:\r?\n|$)/gm, "");
  if (!locked) return clean;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `${clean}${clean && !clean.endsWith("\n") ? eol : ""}locked: true${eol}`;
}

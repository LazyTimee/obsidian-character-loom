import { Choice, defaultTables, Tables } from "./data";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function validateSettings(saved: unknown): { tables: Tables; errors: string[] } {
  const errors: string[] = [];
  const tables = structuredClone(defaultTables);
  const error = (path: string, message: string) => { errors.push(`${path}: ${message}`); };
  if (saved === null || saved === undefined) return { tables, errors };
  if (!isObject(saved) || !isObject(saved.tables)) {
    error("tables", "ожидался объект таблиц");
    return { tables, errors };
  }
  const readChoices = (input: unknown, path: string, nested = false): Choice[] => {
    if (!Array.isArray(input)) { error(path, "ожидался массив вариантов"); return []; }
    const result: Choice[] = [];
    input.forEach((entry: unknown, index) => {
      const itemPath = `${path}[${index}]`;
      if (!isObject(entry)) { error(itemPath, "ожидался объект варианта"); return; }
      let valid = true;
      const invalid = (field: string, message: string) => { error(`${itemPath}.${field}`, message); valid = false; };
      if (typeof entry.value !== "string") invalid("value", "ожидалась строка");
      if (typeof entry.weight !== "number" || !Number.isSafeInteger(entry.weight) || entry.weight < 0)
        invalid("weight", "ожидалось неотрицательное безопасное целое число");
      for (const key of ["gender", "pairedValue", "subtableName"]) {
        if (entry[key] !== undefined && typeof entry[key] !== "string") invalid(key, "ожидалась строка");
      }
      if (nested && (entry.children !== undefined || entry.subtableName !== undefined))
        invalid("children", "поддерживается только один уровень подтаблиц");
      const children = entry.children === undefined ? undefined : readChoices(entry.children, `${itemPath}.children`, true);
      if (entry.children !== undefined && (!Array.isArray(entry.children) || (entry.children.length > 0 && !children?.length))) valid = false;
      if (!valid) return;
      const item: Choice = { value: entry.value as string, weight: entry.weight as number };
      for (const key of ["gender", "pairedValue", "subtableName"] as const) {
        if (typeof entry[key] === "string") item[key] = entry[key];
      }
      if (children !== undefined) item.children = children;
      result.push(item);
      paths.set(item, itemPath);
    });
    return result;
  };
  const paths = new WeakMap<Choice, string>();
  for (const [key, value] of Object.entries(saved.tables)) {
    Object.defineProperty(tables, key, { value: readChoices(value, `tables.${key}`), enumerable: true, writable: true, configurable: true });
  }
  const pathOf = (item: Choice) => paths.get(item) ?? "tables.gender";
  const ids = new Map<string, Choice[]>();
  for (const parent of tables.gender) {
    for (const item of parent.children ?? [parent]) {
      if (!item.value.trim() || !item.gender?.trim()) {
        error(`${pathOf(item)}.gender`, "у пола должны быть непустые значение и идентификатор");
        continue;
      }
      const matches = ids.get(item.gender) ?? [];
      matches.push(item);
      ids.set(item.gender, matches);
    }
  }
  const targets = new Set<string>();
  for (const [id, items] of ids) {
    if (items.length === 1) targets.add(id);
    else for (const item of items) error(`${pathOf(item)}.gender`, `повторяющийся идентификатор пола ${JSON.stringify(id)}`);
  }
  const filter = (items: Choice[], key: string): Choice[] => items.filter(item => {
    if (key === "gender" && item.children === undefined) {
      if (!item.value.trim() || !item.gender || !targets.has(item.gender)) return false;
    } else if (key !== "gender" && item.gender && !targets.has(item.gender)) {
      error(`${pathOf(item)}.gender`, `пол ${JSON.stringify(item.gender)} не существует или его идентификатор неоднозначен`);
      return false;
    }
    if (item.children) {
      const hadChildren = item.children.length > 0;
      item.children = filter(item.children, key);
      if (hadChildren && !item.children.length) return false;
    }
    return true;
  });
  for (const key of Object.keys(tables)) tables[key] = filter(tables[key], key);
  return { tables, errors };
}

import { Choice, defaultTables, genderFields, Tables } from "./data";
import { genderChoices, prepareTables } from "./core";
import { validateSettings } from "./settings-validation";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const known = (key: string) => Object.hasOwn(defaultTables, key);
const emptyTables = (): Tables => Object.fromEntries(Object.keys(defaultTables).map(key => [key, []]));

function selectedKeys(tables: Tables, key?: string): string[] {
  if (!key) return Object.keys(tables);
  if (!known(key) || !Object.hasOwn(tables, key)) throw new Error("В файле нет выбранной таблицы.");
  return [key, ...(genderFields.includes(key) ? ["gender"] : [])]
    .filter(name => Object.hasOwn(tables, name));
}

/** A portable subset uses the same { tables } shape as data.json. */
export function exportTables(tables: Tables, key?: string): { tables: Tables } {
  const result: Tables = {};
  const clean = (items: Choice[]): Choice[] => items
    .filter(item => item.value.trim() || item.pairedValue?.trim())
    .map(item => ({
      value: item.value.replace(/[\r\n]+/g, " ").trim(), weight: item.weight,
      ...(item.gender !== undefined ? { gender: item.gender } : {}),
      ...(item.pairedValue !== undefined ? { pairedValue: item.pairedValue.replace(/[\r\n]+/g, " ").trim() } : {}),
      ...(item.subtableName !== undefined ? { subtableName: item.subtableName } : {}),
      ...(item.children !== undefined ? { children: clean(item.children) } : {})
    }));
  for (const name of selectedKeys(tables, key)) result[name] = clean(tables[name]);
  return { tables: result };
}

export function parseTableFile(text: string): Tables {
  let input: unknown;
  try { input = JSON.parse(text); }
  catch { throw new Error("Некорректный JSON."); }
  if (!object(input) || Object.keys(input).some(key => key !== "tables") || !object(input.tables) || !Object.keys(input.tables).length)
    throw new Error("Ожидался объект { \"tables\": { ... } } с таблицами.");
  for (const [key, entries] of Object.entries(input.tables)) {
    if (!known(key)) throw new Error(`Неизвестная таблица: ${key}.`);
    if (!Array.isArray(entries)) throw new Error(`tables.${key}: ожидался массив.`);
    const check = (items: unknown[], nested = false) => {
      for (const entry of items) {
        if (!object(entry)) throw new Error(`tables.${key}: ожидался объект варианта.`);
        const allowed = ["value", "weight", "gender", "pairedValue", "subtableName", "children"];
        if (Object.keys(entry).some(field => !allowed.includes(field))) throw new Error(`tables.${key}: неизвестное поле варианта.`);
        if (typeof entry.value !== "string" || (!entry.value.trim() && !(typeof entry.pairedValue === "string" && entry.pairedValue.trim())) || /[\r\n]/.test(entry.value))
          throw new Error(`tables.${key}: ожидалось непустое значение или текст предыстории без переноса строки в значении.`);
        if (entry.children !== undefined) {
          if (nested || !Array.isArray(entry.children)) throw new Error(`tables.${key}: некорректная подтаблица.`);
          check(entry.children, true);
        }
      }
    };
    check(entries);
  }
  // Missing tables stay empty: validation must not introduce built-in values or genders.
  const validated = validateSettings({ tables: { ...emptyTables(), ...input.tables } });
  if (validated.errors.length) throw new Error(validated.errors.slice(0, 5).join("\n"));
  return Object.fromEntries(Object.keys(input.tables).map(key => [key, validated.tables[key]]));
}

export function mergeTables(current: Tables, imported: Tables, key?: string): { tables: Tables; added: number } {
  const incoming = exportTables(imported, key).tables;
  const tables = { ...emptyTables(), ...exportTables(current).tables };
  const ids = new Map<string, string>();
  const existingGenders = genderChoices(tables);
  const byName = new Map(existingGenders.map(item => [item.value.trim(), item.gender!]));
  const used = new Set(existingGenders.map(item => item.gender));
  for (const item of genderChoices(incoming)) {
    const original = item.gender!;
    let id = byName.get(item.value.trim());
    if (!id) {
      id = used.has(original) ? crypto.randomUUID() : original;
      used.add(id);
      byName.set(item.value.trim(), id);
    }
    ids.set(original, id);
  }
  for (const items of Object.values(incoming)) {
    for (const item of items.flatMap(item => [item, ...(item.children ?? [])])) {
      if (item.gender) item.gender = ids.get(item.gender) ?? item.gender;
    }
  }
  // Gender targets are global, even when files group them in different subtables.
  const seenGenders = new Set(existingGenders.map(item => item.gender));
  const newGender = (item: Choice) => {
    if (seenGenders.has(item.gender)) return false;
    seenGenders.add(item.gender); return true;
  };
  if (incoming.gender) incoming.gender = incoming.gender.filter(item => {
    if (!item.children) return newGender(item);
    const count = item.children.length;
    item.children = item.children.filter(newGender);
    return !count || item.children.length > 0;
  });
  let added = 0;
  const merge = (target: Choice[], source: Choice[], parentGender = "", sourceGender = "", genderTable = false) => {
    const identity = (item: Choice, inherited: string) => JSON.stringify([
      item.value.trim(), genderTable && item.children ? "" : item.gender ?? inherited, item.pairedValue ?? ""
    ]);
    const index = new Map(target.map(item => [identity(item, parentGender), item]));
    for (const item of source) {
      const id = identity(item, sourceGender);
      const existing = index.get(id);
      if (!existing) {
        target.push(item); index.set(id, item);
        added++;
        // Deduplicate children even when their parent is new.
        if (item.children) {
          const children = item.children; item.children = [];
          merge(item.children, children, item.gender ?? sourceGender, item.gender ?? sourceGender, genderTable);
        }
      } else if (item.children?.length) {
        existing.children ??= [];
        merge(existing.children, item.children, existing.gender ?? parentGender, item.gender ?? sourceGender, genderTable);
      }
    }
  };
  for (const [name, items] of Object.entries(incoming)) {
    tables[name] ??= [];
    merge(tables[name], items, "", "", name === "gender");
  }
  const checked = validateSettings({ tables });
  if (checked.errors.length) throw new Error(checked.errors.slice(0, 5).join("\n"));
  prepareTables(tables);
  return { tables, added };
}

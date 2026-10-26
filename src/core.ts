import { Choice, defaultGenders, fieldOrder, Gender, genderFields, Tables, valueOrder } from "./data";

export type Values = Record<string, string>;
export type Block = { lineStart: number; from: number; to: number; source: string };

function integerWeight(weight: number): number {
  return Number.isFinite(weight) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(weight))) : 0;
}

export function normalize(items: Choice[]): void {
  items.forEach(item => item.weight = integerWeight(item.weight));
}
export function setWeight(_items: Choice[], item: Choice, weight: number): void {
  item.weight = integerWeight(weight);
}
export function weightPercent(items: Choice[], item: Choice): number {
  const largest = Math.max(0, ...items.map(entry => entry.weight));
  if (!largest) return 0;
  const sum = items.reduce((total, entry) => total + entry.weight / largest, 0);
  return (item.weight / largest) / sum * 100;
}
export function genderChoices(tables: Tables): Choice[] {
  return (tables.gender ?? []).flatMap(item => item.children ?? [item]).filter(item => item.value.trim());
}
export function genderLabel(tables: Tables, gender: Gender): string | undefined {
  return genderChoices(tables).find(item => item.gender === gender)?.value;
}
export function choiceGender(item: Choice, parent?: Choice): Gender | undefined {
  return parent?.gender || item.gender;
}
export function choicePercent(items: Choice[], item: Choice, parent?: Choice): number {
  const gender = choiceGender(item, parent);
  return weightPercent(gender ? items.filter(entry => !choiceGender(entry, parent) || choiceGender(entry, parent) === gender) : items, item);
}
export function clearGender(tables: Tables, gender: Gender): void {
  for (const key of genderFields) {
    for (const item of tables[key] ?? []) {
      if (item.gender === gender) delete item.gender;
      for (const child of item.children ?? []) if (child.gender === gender) delete child.gender;
    }
  }
}
export function addChoice(items: Choice[], item: Choice): void {
  item.weight = 1;
  items.push(item);
}
export function prepareTables(tables: Tables): void {
  tables.gender ??= structuredClone(defaultGenders);
  for (const item of tables.gender.flatMap(item => [item, ...(item.children ?? [])])) {
    item.gender ||= item.value === "Мужчина" ? "male" : item.value === "Женщина" ? "female" : crypto.randomUUID();
  }
  const genders = new Set(genderChoices(tables).map(item => item.gender));
  for (const key of ["gender", ...fieldOrder]) {
    tables[key] ??= [];
    for (const item of tables[key]) {
      if (genderFields.includes(key) && item.gender && !genders.has(item.gender)) delete item.gender;
      if (item.children) {
        item.children = item.children.filter(child => child.value.trim());
        for (const child of item.children) {
          delete child.children; delete child.subtableName;
          if (genderFields.includes(key) && child.gender && !genders.has(child.gender)) delete child.gender;
          if (genderFields.includes(key) && item.gender) child.gender = item.gender;
        }
        if (item.children.length) normalize(item.children);
        else if (!genderFields.includes(key)) { delete item.children; delete item.subtableName; }
      }
    }
    normalize(tables[key]);
  }
}
export function pick(items: Choice[], random = Math.random): Choice | undefined {
  const sum = items.reduce((total, item) => total + Math.max(0, item.weight), 0);
  if (!sum) return undefined;
  let point = random() * sum;
  for (const item of items) {
    point -= Math.max(0, item.weight);
    if (point < 0) return item;
  }
  return [...items].reverse().find(item => item.weight > 0);
}
export function findChoice(tables: Tables, key: string, value: string): { item: Choice; parent?: Choice } | undefined {
  for (const item of tables[key] ?? []) {
    const child = item.children?.find(child => child.value === value);
    if (child) return { item: child, parent: item };
    if (item.value === value) return { item };
  }
}
export function valueGender(tables: Tables, key: string, value: string): Gender | undefined {
  if (key === "gender") return genderChoices(tables).find(item => item.value === value)?.gender;
  const found = findChoice(tables, key, value);
  return found ? choiceGender(found.item, found.parent) || undefined : undefined;
}
export function currentGender(tables: Tables, values: Values): Gender | undefined {
  return values.gender ? valueGender(tables, "gender", values.gender) : valueGender(tables, "gender-age", values["gender-age"]);
}
export function pickForGender(items: Choice[], gender: Gender | undefined, random = Math.random, excludedValue?: string, inheritGender = true): Choice | undefined {
  const eligible = items.flatMap(parent => {
    if (!parent.value.trim()) return [];
    if (parent.children) {
      const children = parent.children.filter(child => child.value.trim() && (!gender || !choiceGender(child, parent) || choiceGender(child, parent) === gender));
      return children.some(child => child.weight > 0) ? [{ ...parent, children }] : [];
    }
    return !gender || !parent.gender || parent.gender === gender ? [parent] : [];
  });
  const singleGenderGroup = gender && items.filter(item => item.gender === gender).length === 1 && eligible.length === 1 && eligible[0].children;
  const alternatives = eligible.flatMap(parent => {
    if (!parent.children) return parent.value === excludedValue ? [] : [parent];
    const children = parent.children.filter(child => child.value !== excludedValue);
    const total = parent.children.reduce((sum, child) => sum + Math.max(0, child.weight), 0);
    const remaining = children.reduce((sum, child) => sum + Math.max(0, child.weight), 0);
    return remaining ? [{ ...parent, children, weight: parent.weight * (remaining / total) }] : [];
  });
  const parent = singleGenderGroup ? alternatives[0] : pick(alternatives, random);
  const child = parent?.children?.length ? pick(parent.children, random) : parent;
  return child && { ...child, gender: inheritGender ? choiceGender(child, parent) : child.gender ?? parent?.gender };
}
export function generate(tables: Tables, key: string, values: Values = {}, random = Math.random, excludeCurrent = true): Values {
  if (key === "backstory-text") key = "backstory-title";
  const genderNow = currentGender(tables, values);
  if (key === "gender") {
    const genders = genderChoices(tables);
    const alternatives = genders.filter(item => item.gender !== genderNow && item.value !== values.gender);
    const selected = excludeCurrent && genderNow
      ? pick(alternatives, random)
      : pickForGender(tables.gender ?? defaultGenders, undefined, random, undefined, false);
    const selectedGender = selected?.gender;
    if (!selectedGender || !selected) return {};
    const age = pickForGender(tables["gender-age"] ?? [], selectedGender, random, excludeCurrent ? values["gender-age"] : undefined)
      ?? pickForGender(tables["gender-age"] ?? [], selectedGender, random);
    const name = pickForGender(tables.name ?? [], selectedGender, random, excludeCurrent ? values.name : undefined)
      ?? pickForGender(tables.name ?? [], selectedGender, random);
    const updates: Values = { gender: selected.value, "gender-age": age?.value ?? "", name: name?.value ?? "" };
    const surnameGender = valueGender(tables, "surname", values.surname);
    if (surnameGender && surnameGender !== selectedGender) {
      const surname = pickForGender(tables.surname ?? [], selectedGender, random);
      updates.surname = surname?.value ?? "";
    }
    return updates;
  }
  if (genderFields.includes(key) && (values.gender || values["gender-age"]) && !genderNow) return {};
  const needsGender = genderFields.includes(key);
  const selectedGender = needsGender ? genderNow ?? pickForGender(tables.gender ?? defaultGenders, undefined, random, undefined, false)?.gender : undefined;
  if (needsGender && !selectedGender) return {};
  const selected = pickForGender(tables[key] ?? [], selectedGender, random, excludeCurrent ? values[key] : undefined);
  if (!selected) return {};
  const updates: Values = key === "backstory-title"
    ? { "backstory-title": selected.value, "backstory-text": selected.pairedValue ?? "" }
    : { [key]: selected.value };
  if (key === "gender-age" && selected.gender && selected.gender !== genderNow) {
    for (const pairedKey of ["name", "surname"]) {
      if (pairedKey === "surname") {
        const surnameGender = valueGender(tables, pairedKey, values[pairedKey]);
        if (!surnameGender || surnameGender === selected.gender) continue;
      }
      const paired = pickForGender(tables[pairedKey] ?? [], selected.gender, random);
      updates[pairedKey] = paired?.value ?? "";
    }
  }
  if (key === "gender-age" && !values.gender && selectedGender) updates.gender = genderLabel(tables, selectedGender) ?? "";
  return updates;
}
export function generateAll(tables: Tables, values: Values = {}, onlyMissing = false): Values {
  const updates: Values = {};
  if (onlyMissing && !values.gender) {
    const gender = currentGender(tables, values);
    if (gender) updates.gender = genderLabel(tables, gender) ?? "";
  }
  if (!onlyMissing || (!values.gender && !updates.gender)) {
    const gender = pickForGender(tables.gender ?? defaultGenders, undefined, Math.random, undefined, false);
    if (gender) updates.gender = gender.value;
  }
  // Pick gender before name for a fresh card or a full reroll.
  for (const key of ["gender-age", ...fieldOrder.filter(key => key !== "gender-age")]) {
    const current = { ...(onlyMissing ? values : {}), ...updates };
    if ((!onlyMissing || !current[key]) && !(genderFields.includes(key) && !current.gender)) {
      Object.assign(updates, generate(tables, key, current, Math.random, false));
      if (!onlyMissing && genderFields.includes(key) && updates[key] === undefined) updates[key] = "";
    }
  }
  if (onlyMissing && !values["backstory-text"] && !updates["backstory-text"]) {
    const story = findChoice(tables, "backstory-title", updates["backstory-title"] ?? values["backstory-title"]);
    if (story?.item.pairedValue) updates["backstory-text"] = story.item.pairedValue;
  }
  return Object.fromEntries([...valueOrder, "backstory-text"].filter(key => updates[key] !== undefined).map(key => [key, updates[key]]));
}
export function parseValues(source: string): Values {
  const values: Values = {};
  const known = new Set([...valueOrder, "backstory-text"]);
  for (const line of source.split(/\r?\n/)) {
    const match = /^[\t ]*([a-z-]+)[\t ]*:[\t ]*(.*?)[\t ]*$/.exec(line);
    if (match && known.has(match[1]) && values[match[1]] === undefined) values[match[1]] = match[2];
  }
  return values;
}
export function replaceValue(source: string, key: string, value: string): string {
  const expression = new RegExp(`^([\\t ]*${key}[\\t ]*:[\\t ]*).*$`, "m");
  if (expression.test(source)) return source.replace(expression, (_line, prefix: string) => prefix + value);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `${source}${source && !source.endsWith("\n") ? eol : ""}${key}: ${value}${eol}`;
}
export function applyValues(source: string, values: Values): string {
  const fresh = !source.trim();
  const order = [...valueOrder, "backstory-text"];
  const entries = Object.entries(values).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  for (const [key, value] of entries) {
    if (fresh && ["gender", "quirk", "gender-age", "backstory-title"].includes(key) && source.trim()) source += "\n";
    source = replaceValue(source, key, value);
  }
  // Keep comments, unknown keys and line endings in place. Stable sorting keeps
  // the first occurrence authoritative when a key is repeated.
  const lines: Array<{ line: string; key: string }> = [];
  const slots = new Set<number>();
  for (const match of source.matchAll(/^[^\r\n]+/gm)) {
    const key = /^[\t ]*([a-z-]+)[\t ]*:/.exec(match[0])?.[1];
    if (!key || !order.includes(key)) continue;
    slots.add(match.index);
    lines.push({ line: match[0], key });
  }
  lines.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  let index = 0;
  return source.replace(/^[^\r\n]+/gm, (line, offset: number) => slots.has(offset) ? lines[index++].line : line);
}
export function readBlocks(document: string): Block[] {
  const lines = [...document.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(lines[i][0]);
    if (!opening) continue;
    const fence = opening[1];
    const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[\\t ]*\\r?\\n?$`);
    const start = i;
    while (++i < lines.length && !close.test(lines[i][0])) { /* skip fenced content */ }
    if (i >= lines.length) break;
    if (opening[2].trim() !== "cloom") continue;
    const from = lines[start].index + lines[start][0].length;
    const to = lines[i].index;
    blocks.push({ lineStart: start, from, to, source: document.slice(from, to) });
  }
  return blocks;
}
export function locateBlock(document: string, source: string, lineStart?: number): Block | undefined {
  const blocks = readBlocks(document);
  const same = (block: Block) => block.source.trimEnd() === source.trimEnd();
  const atLine = blocks.find(block => block.lineStart === lineStart && same(block));
  if (atLine) return atLine;
  const matches = blocks.filter(same);
  return matches.length === 1 ? matches[0] : undefined;
}

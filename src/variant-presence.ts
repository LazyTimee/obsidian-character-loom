import { Choice, Tables } from "./data";
import { Values } from "./core";

const normalized = (value: string): string => value.replace(/[\r\n]+/g, " ").trim();

export function knownVariant(tables: Tables, key: string, values: Values): boolean {
  if (key === "backstory-text") key = "backstory-title";
  const matches = (item: Choice): boolean =>
    normalized(item.value) === normalized(values[key] ?? "")
    && (key !== "backstory-title" || normalized(item.pairedValue ?? "") === normalized(values["backstory-text"] ?? ""));
  const contains = (items: Choice[]): boolean => items.some(item => matches(item) || !!item.children && contains(item.children));
  return contains(tables[key] ?? []);
}

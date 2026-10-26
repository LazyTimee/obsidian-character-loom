import { Notice } from "obsidian";
import { Choice, defaultTables, Tables } from "./data";
import { prepareTables } from "./core";
import { validateSettings } from "./settings-validation";

export type CloomSettings = { tables: Tables };
type SettingsIO = { load(): Promise<unknown>; save(settings: CloomSettings): Promise<void> };

export class SettingsStore {
  errors: string[] = [];
  private saving = Promise.resolve();

  constructor(private io: SettingsIO) {}

  async load(): Promise<CloomSettings> {
    let loaded: ReturnType<typeof validateSettings>;
    try { loaded = validateSettings(await this.io.load()); }
    catch (error) {
      loaded = { tables: structuredClone(defaultTables), errors: [`Файл настроек генератора: не удалось прочитать настройки: ${String(error)}`] };
    }
    this.errors = loaded.errors;
    const settings = { tables: loaded.tables };
    prepareTables(settings.tables);
    if (this.errors.length) {
      new Notice(`Character Loom: ошибки в файле настроек генератора (${this.errors.length}). Сохранение таблиц заблокировано. Подробности в настройках Character Loom.`, 0);
    }
    return settings;
  }

  async save(settings: CloomSettings): Promise<void> {
    if (this.errors.length) throw new Error("Character Loom: сохранение заблокировано. Исправьте файл настроек генератора вручную и перезапустите плагин или восстановите данные по умолчанию.");
    await this.write(settings);
  }

  async restoreDefaults(): Promise<CloomSettings> {
    const settings = { tables: structuredClone(defaultTables) };
    prepareTables(settings.tables);
    await this.write(settings);
    this.errors = [];
    return settings;
  }

  private async write(settings: CloomSettings): Promise<void> {
    const saved = structuredClone(settings);
    const clean = (items: Choice[]): Choice[] => items.filter(item => item.value.trim() || item.pairedValue?.trim()).map(item => {
      delete (item as Choice & { id?: string }).id;
      item.value = item.value.replace(/[\r\n]+/g, " ").trim();
      if (item.pairedValue !== undefined) item.pairedValue = item.pairedValue.replace(/[\r\n]+/g, " ").trim();
      if (item.children) item.children = clean(item.children);
      return item;
    });
    for (const key of Object.keys(saved.tables)) saved.tables[key] = clean(saved.tables[key]);
    prepareTables(saved.tables);
    const saving = this.saving.catch(() => {}).then(() => this.io.save(saved));
    this.saving = saving;
    await saving;
  }
}

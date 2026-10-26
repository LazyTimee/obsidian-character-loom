import { addIcon, Notice, Plugin } from "obsidian";
import { CloomSettingTab } from "./settings";
import { CloomSettings, SettingsStore } from "./settings-store";
import { GenerationHistoryStore } from "./generation-history";
import { DocumentController } from "./document-controller";
import { CardController } from "./card-controller";
import { insertGenerator } from "./insert-generator";
import type { Tables } from "./data";
export { CloomSettingTab } from "./settings";

export default class CharacterLoom extends Plugin {
  declare settings: CloomSettings;
  private readonly settingsStore = new SettingsStore({ load: () => this.loadData(), save: settings => this.saveData(settings) });
  readonly history = new GenerationHistoryStore(() => this.app.workspace);
  readonly documents = new DocumentController({
    app: () => this.app,
    tables: () => this.settings.tables,
    history: this.history,
    refreshCards: path => this.cardController.refreshCards(path),
    report: error => this.report(error)
  });
  readonly cardController = new CardController({
    app: () => this.app,
    tables: () => this.settings.tables,
    errors: () => this.settingsErrors,
    documents: this.documents,
    history: this.history,
    saveSettings: refresh => this.saveSettings(refresh),
    report: error => this.report(error)
  });

  get settingsErrors(): readonly string[] { return this.settingsStore.errors; }

  async onload(): Promise<void> {
    addIcon("cloom-triangle-left", '<path fill="currentColor" stroke="none" d="M25 50 75 15V85Z"/>');
    addIcon("cloom-triangle-right", '<path fill="currentColor" stroke="none" d="M75 50 25 15V85Z"/>');
    addIcon("cloom-d20", '<g fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"><path d="M50 4 91 27 91 73 50 96 9 73 9 27Z M9 27 50 20 91 27 74 74 26 74Z M50 4V20 M9 73 26 74 50 96 74 74 91 73 M26 74 50 20 74 74"/></g><text x="50" y="65" text-anchor="middle" fill="currentColor" font-size="23" font-family="sans-serif">20</text>');
    this.settings = await this.settingsStore.load();
    this.addSettingTab(new CloomSettingTab(this.app, this));
    this.addCommand({
      id: "insert-generator",
      name: "Вставить генератор после текущего блока",
      editorCallback: editor => insertGenerator(editor)
    });
    this.cardController.register(this);
    this.documents.register(this);
    this.history.register(this, (oldPath, newPath) => this.cardController.moveTargets(oldPath, newPath));
  }

  async saveSettings(refresh = true): Promise<void> {
    await this.settingsStore.save(this.settings);
    if (refresh) this.cardController.refreshAll();
  }

  async importTables(tables: Tables): Promise<void> {
    await this.settingsStore.save({ tables });
    this.settings = { tables };
    this.cardController.refreshAll();
  }

  async restoreDefaultSettings(): Promise<void> {
    this.settings = await this.settingsStore.restoreDefaults();
    this.cardController.refreshAll();
  }

  private report(error: unknown): void {
    console.error("Character Loom", error);
    new Notice("Character Loom: не удалось сохранить изменения. Подробности в консоли.");
  }
}

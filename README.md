# Character Loom

English | [Русский](README.ru.md)

A fantasy tabletop role-playing character generator for Obsidian. Create characters directly in your notes and customize the tables to suit your world.

**Language: the plugin interface and default tables are in Russian. An English interface is not currently available.**

## Features

- Character cards with a first name, surname, gender, age, race, appearance, personality, and backstory.
- Generate an entire card, individual sections, or individual fields.
- Undo generation and lock cards to prevent changes.
- Custom entries, probability weights, and subtables.
- Search entries and import or export tables as JSON.
- Works in Live Preview and Reading view.

## Installation

Once the plugin is published in the official Obsidian community plugin directory:

1. Open **Settings → Community plugins** and allow community plugins.
2. Browse the plugin directory and search for **Character Loom**.
3. Click **Install**.
4. Enable the plugin in the community plugin list.

Install updates through **Community plugins** in Obsidian settings.

## Quick start

Insert an empty block into a note:

````markdown
```cloom
```
````

In Live Preview, move the cursor outside the block, or open Reading view. The plugin will generate a character and save it in the note.

You can also run **Character Loom: Вставить генератор после текущего блока** from the command palette. The Russian command name means “Insert generator after the current block.”

### Using a character card

- Click the die next to a field to generate another value.
- Use the section buttons to regenerate appearance or backstory, or **Другой персонаж** (“Another character”) to regenerate the entire card.
- Use the undo button to restore the previous generation result.
- Close the lock to prevent editing and generation. Click it again to unlock the card.

In Live Preview, clicking a filled value opens the entry editor. You can change the value and its weight, save it, or delete the entry from the table. These actions update the table and the current card; other cards keep their values. The entry editor is unavailable in Reading view.

You can place multiple independent cards in one note.

## Customizing tables

Open **Settings → Character Loom** to add, edit, or delete entries, create subtables, and search entries.

Weights determine selection probabilities: entries with weights of `1`, `1`, and `2` have chances of `25%`, `25%`, and `50%`. A weight of `0` excludes an entry from generation. First names, surnames, and ages can be assigned to a specific gender or allowed for any gender.

Import and export support all tables at once or an individual section. Import adds new entries while preserving existing weights; importing the same file again does not create duplicates.

**Восстановить по умолчанию** (“Restore defaults”) replaces custom tables with the default tables. Export your tables before restoring defaults.

## Data storage

Characters are saved in `cloom` blocks within notes. Tables are stored in `data.json` in the installed plugin folder. The plugin works locally and makes no network requests.

## Development

Building requires Node.js and pnpm. Run these commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

The build creates `main.js` in the repository root. Install it together with `manifest.json` and `styles.css`.

Source code is in `src/`; default tables are in `src/default-tables.json`.

## License

[MIT](LICENSE).

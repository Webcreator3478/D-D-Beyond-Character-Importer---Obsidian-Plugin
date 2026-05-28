# Contributing to DnD Beyond Importer

Thanks for taking the time to contribute! This guide covers everything you need to get started.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Ways to Contribute](#ways-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Reporting Bugs](#reporting-bugs)
- [Requesting Features](#requesting-features)
- [Notes on the D&D Beyond API](#notes-on-the-dnd-beyond-api)

---

## Code of Conduct

Please be respectful and constructive. This is a hobby project — everyone contributing is doing so in their own time.

---

## Ways to Contribute

- Fix a bug
- Improve the character note output (Markdown formatting, new sections)
- Improve roll sheet accuracy (better modifier calculations, edge cases)
- Add support for more character data (class features, spell descriptions, etc.)
- Improve mobile compatibility
- Write or improve documentation
- Triage open issues

---

## Development Setup

You will need **Node.js 18+** and **npm**.

```bash
git clone https://github.com/Webcreator3478/D-D-Beyond-Character-Importer---Obsidian-Plugin.git
cd D-D-Beyond-Character-Importer---Obsidian-Plugin
npm install
```

### Dev build (watch mode)

```bash
npm run dev
```

This compiles `main.ts` to `main.js` and watches for changes.

### Production build

```bash
npm run build
```

Runs the TypeScript type-checker (`tsc --noEmit`) first, then bundles with esbuild.

### Testing in Obsidian

The easiest way to test locally is to symlink the project folder into a test vault:

```
<YourTestVault>/.obsidian/plugins/dndbeyond-importer/ → <this repo>/
```

After each `npm run dev` rebuild, reload Obsidian (Ctrl/Cmd + R inside the app, or use the **Hot Reload** community plugin).

---

## Project Structure

```
main.ts              — All plugin source code (single-file plugin)
esbuild.config.mjs   — Build configuration
manifest.json        — Plugin metadata (id, name, version, minAppVersion)
package.json         — npm dependencies and build scripts
tsconfig.json        — TypeScript configuration
RELEASE_NOTES.md     — Changelog (one section per version)
CONTRIBUTING.md      — This file
```

The entire plugin lives in `main.ts`. Key sections, in order:

| Section | What it does |
|:---|:---|
| Interfaces | TypeScript types for D&D Beyond API responses |
| Data helpers | `modStr`, `profBonus`, `getStatValue`, `calcHP`, `calcAC`, etc. |
| `buildMarkdown` | Assembles the full character note from API data |
| Section builders | `buildSavingThrows`, `buildSkillsSection`, `buildActionsSection`, etc. |
| `extractActions` | Derives attack/damage actions from inventory and cantrips |
| `DnDBeyondImporterPlugin` | Main plugin class — ribbon icons, commands, import logic |
| `ImportModal` | URL/ID input modal |
| `CharacterSheetModal` | Roll sheet modal |
| `DiceRollerModal` | Standalone dice roller modal |
| `DnDBeyondSettingTab` | Settings UI |

---

## Making Changes

### Conventions

- All source is TypeScript with `strict: true` — no `any` unless there is genuinely no alternative.
- Keep the single-file structure. Do not split into multiple files unless there is a compelling reason.
- Comment new sections with the same `// ── Title ─────` style used throughout the file.
- Follow the existing code style (tabs, same brace placement).

### Adding a new character data section to the note

1. Add any new fields you need to the relevant `Ddb*` interface (e.g. `DdbCharacter`).
2. Write a `build<Section>(char: DdbCharacter, ...): string` function that returns Markdown.
3. Call it from `buildMarkdown` in the appropriate place.
4. Add a corresponding toggle to `DnDBeyondImporterSettings` and `DnDBeyondSettingTab` if the section should be optional.

### Adding a new roll to the Roll Sheet

1. Compute the modifier in `CharacterSheetModal.onOpen()`.
2. Create a row/cell element and call `this.makeRollBtn(container, label, modifier)`.

### Updating the D&D Beyond API mapping

The API response is typed through the `Ddb*` interfaces. If you find a field in the API that is not yet typed, add it to the correct interface before using it. Do not use untyped property access.

---

## Submitting a Pull Request

1. Fork the repository and create a branch from `main`:
   ```bash
   git checkout -b fix/weapon-damage-dice
   ```
2. Make your changes and verify `npm run build` passes with no TypeScript errors.
3. Update `RELEASE_NOTES.md` — add your change under a new `## vX.Y.Z` heading (or under an existing unreleased heading if one exists). Follow the existing format.
4. Open a pull request against `main`. In the PR description, explain what the change does and why.

### Commit messages

Use short, imperative present-tense messages:

```
Fix weapon damage dice for custom items
Add Actions section to character note
Improve ranged weapon ATK modifier calculation
```

---

## Reporting Bugs

Open a GitHub Issue and include:

- Plugin version (from `manifest.json`)
- Obsidian version and platform (desktop / iOS / Android)
- A description of what you expected vs. what happened
- If it's a character parsing issue: the numeric D&D Beyond character ID (the character must be set to Public for the maintainer to reproduce)

---

## Requesting Features

Open a GitHub Issue with the label `enhancement`. Describe the feature, why it would be useful, and any relevant D&D Beyond API fields involved. Screenshots of the D&D Beyond UI are helpful for layout-related requests.

---

## Notes on the D&D Beyond API

The plugin uses an unofficial internal endpoint:

```
https://character-service.dndbeyond.com/character/v5/character/{ID}
```

This is **not** officially documented or supported. A few things to keep in mind when working with it:

- **Field names can change without notice.** If something breaks after a D&D Beyond update, compare the raw API response against the `Ddb*` interfaces.
- **Custom and homebrew items** may not follow the same schema as official items. The `weaponBehaviors` array is used for custom weapons that lack a standard `damage` field. When adding new inventory-related features, test with both official and homebrew content if possible.
- **The plugin is read-only.** It never writes anything back to D&D Beyond. Please keep it that way.
- **Character must be Public.** Private characters return an error or empty data — this is intentional on D&D Beyond's side and not something the plugin can work around.

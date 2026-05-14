# D&D Beyond Importer — Obsidian Plugin

Import any **public** D&D Beyond character sheet directly into your Obsidian vault as a richly-formatted Markdown note.

---

## Features

- 📋 **Full character sheet** — ability scores, saving throws, skills, HP, AC, speed, proficiency bonus
- ⚔️ **Equipment** — full inventory table with equipped status and weight
- 📖 **Spells** — grouped by level, with school, cast time, range, concentration, and prepared status
- 🌟 **Features & Traits** — racial traits, feats, personality/ideals/bonds/flaws
- 💰 **Currency** — all coin types
- 📜 **Backstory & Notes** — character backstory and campaign notes
- 🏷️ **YAML front matter** — all key stats as queryable properties for use with Dataview or other plugins
- 🔄 **Re-import** — re-running on the same character updates the existing note

---

## Installation

### Manual (recommended until published)

1. Download the latest release zip from the Releases page (or build from source).
2. Extract the folder into your vault's plugin directory:
   ```
   <YourVault>/.obsidian/plugins/dndbeyond-importer/
   ```
   The folder must contain at minimum:
   - `main.js`
   - `manifest.json`
3. In Obsidian → Settings → Community Plugins → enable **D&D Beyond Importer**.

### Build from source

```bash
git clone <this-repo>
cd dndbeyond-importer
npm install
npm run build        # produces main.js
```

---

## Usage

### Via ribbon icon
Click the **⚔️ sword icon** in the left ribbon bar.

### Via command palette
Open the command palette (`Ctrl/Cmd + P`) and run:
> **D&D Beyond Importer: Import character from D&D Beyond**

### Input formats accepted
- Full URL: `https://www.dndbeyond.com/characters/137202151/GpDg8C`
- Short URL: `https://www.dndbeyond.com/characters/137202151`
- Bare ID: `137202151`

> ⚠️ **The character sheet must be set to Public on D&D Beyond.** Private characters cannot be fetched.

---

## Settings

| Setting | Default | Description |
|:---|:---:|:---|
| Output folder | `Characters` | Vault folder where `.md` notes are saved |
| Include spells | ✓ | Import spell list and spell slots |
| Include equipment | ✓ | Import inventory table |
| Include features & traits | ✓ | Import racial traits, feats, personality traits |
| Include backstory & notes | ✓ | Import backstory and campaign notes |

---

## Generated note structure

```
---                          ← YAML front matter (queryable with Dataview)
name, race, class, level
hp_max, hp_current, ac …
tags: ["dnd-character", …]
---

# Character Name
> Class • Race • Level N

## Core Stats        (HP / AC / Speed / Initiative / Prof. Bonus)
## Ability Scores    (STR / DEX / CON / INT / WIS / CHA with modifiers)
## Saving Throws     (proficient saves marked ✓)
## Skills            (proficient ✓, expertise ★)
## Proficiencies & Languages
## Currency
## Equipment         (table: item / qty / equipped / weight)
## Features & Traits (racial traits, feats, personality)
## Spells            (grouped by level, spell slots table)
## Backstory & Notes
## Session Notes     ← blank section for your own notes
```

---

## Notes on the D&D Beyond API

This plugin uses the unofficial internal API endpoint:
```
https://character-service.dndbeyond.com/character/v5/character/{ID}
```
This endpoint is not officially documented or supported by D&D Beyond / Wizards of the Coast. It may change or break at any time. The plugin is a read-only consumer and does not modify any data on D&D Beyond.

---

## License

MIT

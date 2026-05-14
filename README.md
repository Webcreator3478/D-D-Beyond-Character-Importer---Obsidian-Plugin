# D&D Beyond Importer — Obsidian Plugin

Import any **public** D&D Beyond character sheet directly into your Obsidian vault as a richly-formatted Markdown note — and roll dice without ever leaving Obsidian.

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
- 🎲 **Dice Roller** — roll d4, d6, d8, d10, d12, d20, or d100 with toast notifications and full roll history

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
git clone https://github.com/Webcreator3478/D-D-Beyond-Character-Importer---Obsidian-Plugin.git
cd dndbeyond-importer
npm install
npm run build        # produces main.js
```

---

## Usage

### Character Importer

#### Via ribbon icon
Click the **⚔️ sword icon** in the left ribbon bar.

#### Via command palette
Open the command palette (`Ctrl/Cmd + P`) and run:
> **D&D Beyond Importer: Import character from D&D Beyond**

#### Input formats accepted
- Full URL: `https://www.dndbeyond.com/characters/137202151/GpDg8C`
- Short URL: `https://www.dndbeyond.com/characters/137202151`
- Bare ID: `137202151`

> ⚠️ **The character sheet must be set to Public on D&D Beyond.** Private characters cannot be fetched.

---

### Dice Roller

#### Via ribbon icon
Click the **🎲 dice icon** in the left ribbon bar.

#### Via command palette
Open the command palette (`Ctrl/Cmd + P`) and run:
> **D&D Beyond Importer: Open Dice Roller**

#### Available dice
| Die | Sides |
|:---:|:---:|
| d4 | 4 |
| d6 | 6 |
| d8 | 8 |
| d10 | 10 |
| d12 | 12 |
| d20 | 20 |
| d100 | 100 |

Each roll displays the result in the modal, fires an Obsidian toast notification (e.g. `🎲 d20: 17`), and is logged to the roll history with a timestamp. History is capped at the last 50 rolls and can be cleared with the **Clear History** button. History persists across modal opens for the duration of the session.

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

> **Desktop only note:** The plugin uses Obsidian's native `requestUrl` API to bypass browser CORS restrictions. This means character fetching works correctly on Obsidian Desktop (Windows, macOS, Linux). On Obsidian Mobile the request may be blocked depending on your network environment.

---

## License

MIT

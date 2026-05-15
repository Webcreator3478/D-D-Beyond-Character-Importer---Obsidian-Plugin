# D&D Beyond Importer — Obsidian Plugin

Pull any **public** D&D Beyond character sheet into your Obsidian vault as a formatted Markdown note, then roll dice and run checks without ever leaving the app.

---

## What it does

- 📋 **Full character sheet** — ability scores, saving throws, skills, HP, AC, speed, proficiency bonus
- ⚔️ **Equipment** — inventory table with equipped status and weight
- 📖 **Spells** — grouped by level, with school, cast time, range, concentration, and prepared status
- 🌟 **Features & Traits** — racial traits, feats, personality/ideals/bonds/flaws
- 💰 **Currency** — all coin types
- 📜 **Backstory & Notes** — character backstory and campaign notes
- 🏷️ **YAML front matter** — all key stats as queryable properties for Dataview
- 🔄 **Re-import** — running the importer again on the same character updates the existing note in place
- 🎲 **Dice Roller** — d4 through d100 with toast notifications and roll history
- 📊 **Roll Sheet** — per-character modal with roll buttons for every stat, skill, saving throw, and weapon attack

---

## Installation

### Automatic (recommended for stable releases)
1. Open Settings.
2. In the side menu, select Community plugins.
3. Select Browse.
4. Search "D&D Beyond Importer".
5. Select the plugin.
6. Select install.
7. Enable the plugin.
8. Configure plugin settings. (Optional)

### Manual (recommended until published to the community directory / latest releases)

1. Download the latest release zip from the Releases page (or build from source — see below).
2. Unzip into your vault's plugin directory:
   ```
   <YourVault>/.obsidian/plugins/dndbeyond-importer/
   ```
   The folder needs at minimum `main.js` and `manifest.json`.
3. Go to Obsidian → Settings → Community Plugins and enable **D&D Beyond Importer**.

### Build from source

```bash
git clone https://github.com/Webcreator3478/D-D-Beyond-Character-Importer---Obsidian-Plugin.git
cd dndbeyond-importer
npm install
npm run build
```

This produces `main.js` in the project root.

---

## Usage

### Importing a character

**Ribbon:** click the ⚔️ sword icon in the left sidebar.

**Command palette:** `Ctrl/Cmd + P` → *D&D Beyond Importer: Import character from D&D Beyond*

Any of these formats work as input:
- Full URL: `https://www.dndbeyond.com/characters/137202151/GpDg8C`
- Short URL: `https://www.dndbeyond.com/characters/137202151`
- Bare ID: `137202151`

> ⚠️ The character sheet must be set to **Public** on D&D Beyond. Private sheets can't be fetched.

---

### Character Roll Sheet

After importing, a roll sheet opens automatically. You can also reopen it at any time:

**Ribbon:** click the 🎲 dice icon while the character note is active.

**Command palette:** *D&D Beyond Importer: Open Roll Sheet for active character note*

The roll sheet pulls character data from a session cache if the character was already imported this session — otherwise it fetches fresh from the API using the `dndbeyond_id` stored in the note's front matter. Multiple characters are cached independently, so switching between notes works without re-importing anyone.

What's on the roll sheet:
- **Initiative** — d20 + DEX modifier
- **Ability Checks** — one roll button per score (STR / DEX / CON / INT / WIS / CHA)
- **Saving Throws** — proficiency bonus applied automatically; proficient saves marked ✓
- **Skills** — all 18 skills with correct modifiers; expertise (★) and proficiency (✓) shown
- **Actions** — 🎲 ATK and 🎲 DMG buttons for each equipped weapon and attack cantrip

Roll history logs the modifier and total alongside the raw result (e.g. `d20(14)+5 = 19`).

---

### Standalone Dice Roller

If you just want to roll dice without a character sheet open:

**Ribbon:** click the 🎲 dice icon with no character note active.

**Command palette:** *D&D Beyond Importer: Open Dice Roller*

Available dice: d4, d6, d8, d10, d12, d20, d100.

Each roll shows up in the modal, fires a toast notification (e.g. `🎲 d20: 17`), and gets logged to the roll history with a timestamp. History is capped at the last 50 rolls and can be wiped with **Clear History**. It persists across modal opens for the duration of the session.

---

## Settings

| Setting | Default | Description |
|:---|:---:|:---|
| Output folder | `Characters` | Where character notes are saved in your vault |
| Include spells | ✓ | Spell list and spell slots |
| Include equipment | ✓ | Inventory table |
| Include features & traits | ✓ | Racial traits, feats, personality traits |
| Include backstory & notes | ✓ | Backstory and campaign notes |

---

## Note structure

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

## A note on the D&D Beyond API

The plugin fetches from an unofficial internal endpoint:
```
https://character-service.dndbeyond.com/character/v5/character/{ID}
```
This isn't officially documented or supported by D&D Beyond / Wizards of the Coast and could change or break without warning. The plugin is read-only — it never writes anything back to D&D Beyond.

**Mobile:** character fetching uses Obsidian's `requestUrl` API to work around browser CORS restrictions. This works reliably on desktop (Windows, macOS, Linux). On mobile, the request may be blocked depending on your network setup.

---

## License

MIT

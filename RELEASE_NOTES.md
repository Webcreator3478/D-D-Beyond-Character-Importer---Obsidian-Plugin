# Release Notes

## v1.0.3

### New features
- **Roll Sheet from any character note** — open the roll sheet for a character at any time, not just immediately after import.
  - A new **🎲 dices ribbon icon** appears in the left sidebar. Click it while a character note is open to instantly load that character's roll sheet.
  - New command palette entry: **D&D Beyond Importer: Open Roll Sheet for active character note** — same behaviour, keyboard-accessible.
  - The character's data is re-used from an in-session cache if it was already imported this session; otherwise it is fetched live from the D&D Beyond API using the `dndbeyond_id` stored in the note's YAML front matter.
  - Multiple characters are now cached independently — switching between notes and opening their roll sheets works without re-importing.

### Bug fixes
- Removed unused `martialProf` variable (TypeScript warning resolved).
- Removed unused `totalStr` variable in `roll20` method (TypeScript warning resolved).

---

## v1.0.2

### New features
- **Character Roll Sheet** — after importing a character, a roll sheet modal opens automatically with dice roll buttons for every stat.
  - **Initiative** — roll d20 + DEX modifier directly from the sheet.
  - **Ability Checks** — one roll button per ability score (STR/DEX/CON/INT/WIS/CHA).
  - **Saving Throws** — proficiency bonus applied automatically; proficient saves marked ✓.
  - **Skills** — all 18 skills with correct modifiers; expertise (★) and proficiency (✓) included.
  - **Actions** — attack roll (🎲 ATK) and damage roll (🎲 DMG) buttons for each equipped weapon and attack cantrip.
- Roll history now logs the modifier and total alongside the raw die result (e.g. `d20(14)+5 = 19`).
- Re-open the roll sheet any time via command palette: **D&D Beyond Importer: Open Character Roll Sheet**.

### Bug fixes
- Removed plugin name from settings tab heading (Obsidian plugin guideline compliance).

---

## v1.0.1

### Bug fixes
- Removed plugin name from settings tab heading to comply with Obsidian plugin guidelines.

### Notes
- Requires Obsidian 1.4.0 or later.
- Character sheets must be set to **Public** on D&D Beyond for importing to work.

---

## v1.0.0 — Initial release

- Import any public D&D Beyond character sheet as a formatted Markdown note.
- Full character sheet: ability scores, saving throws, skills, HP, AC, speed, proficiency bonus.
- Equipment table, spell list grouped by level, spell slots, features & traits, currency, backstory & notes.
- YAML front matter with all key stats for use with Dataview.
- Re-import support — re-running on the same character updates the existing note.
- Built-in Dice Roller (d4 through d100) with toast notifications and roll history.
- Configurable output folder and toggles for spells, equipment, features, and backstory.

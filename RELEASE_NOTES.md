# Release Notes

## v1.1.0

### New features
- **HP Tracker Modal** — persistent per-character health tracking during a session.
  - Visual HP bar (color-coded: green/yellow/red based on health %)
  - Current HP input field + quick adjust buttons (±1, ±5)
  - Temporary HP tracking (displayed alongside current)
  - Max HP configuration (useful for level-up changes)
  - New command: **D&D Beyond Importer: Open HP Tracker**
  - Supports multiple characters — HP tracking is keyed per character and persists across the session

- **Enhanced Dice Roller** — new filtering, export, and statistics features.
  - **Filter by die type** — dropdown to show only d4, d6, d20, etc. History stats update to match the filter
  - **Export CSV** — download roll history as a spreadsheet-ready CSV file
  - **Copy to Clipboard** — formatted history for pasting into Discord, notes, or other apps
  - **Live Statistics** — average, max, min, and mode displayed below the history. For d20 rolls, shows count of Nat 20+ (🎉) and Nat 1 (💀)

---

## v1.0.4

### Bug fixes
- Removed damage dice fallback for homebrew/custom weapons that have no damage defined. Items such as utility ranged weapons now correctly show ATK-only — no DMG value in the character note and no **🎲 DMG** button in the roll sheet.
- Fixed custom/homebrew weapons (those without `categoryId: 1`) not appearing in the **Actions & Attacks** section at all. They are now detected via the presence of `weaponBehaviors` and included correctly.
- Added missing **## Actions & Attacks** table to the imported character note. Previously attack actions were only visible in the roll sheet modal; they are now written into the Markdown note with columns for ATK bonus, damage, range, and properties.
- Fixed roll sheet **🎲 DMG** button appearing for weapons with no damage data.
- Cleaned up `extractActions` type assertions — replaced scattered `as {…}` casts with a properly typed extended interface.

---

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

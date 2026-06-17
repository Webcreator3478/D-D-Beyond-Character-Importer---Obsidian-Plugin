# Release Notes

## v1.1.2

### New features
- **Refresh button on character notes** — every imported character note now has a **🔄 Refresh from D&D Beyond** button next to **⚔️ Open Interactive Character Sheet**, letting you re-fetch the character and update the note in place without opening the import dialog. The button shows a brief ✅ "Refreshed" or ❌ "Refresh failed" flash so it's clear whether the refresh worked, then resets automatically.

### Bug fixes
- The refresh button is now disabled (with an explanatory tooltip) on notes that don't have a D&D Beyond character ID, instead of attempting — and silently failing — an import with a meaningless fallback ID.
- `importCharacter()` previously swallowed its own errors and returned silently, so a calling function had no way to know an import had failed. It now re-throws after showing its Notice, so the new refresh button (and any future callers) can detect and react to failures.
- Replaced `setAttribute("disabled", "true")` with the standard `button.disabled = true` on the refresh button and the 5etools fetch button, which is the simpler and more correct way to toggle button state.
- Moved the character-sheet launcher buttons' styling out of inline `style.cssText` strings and into `styles.css` (`.dndbi-launcher-row`, `.dndbi-sheet-btn`, `.dndbi-refresh-btn`), improving readability and maintainability.
- Fixed a broken `buildSavingThrows()` helper that referenced `key`, `subType`, and `cells` outside of any enclosing scope — restored the missing `.map()` callback so saving throws render correctly again.

---

## v1.1.1

### Bug fixes
- Fixed README title to match the plugin name in `manifest.json` (`DnD Beyond Importer`) — required by the Obsidian community plugin checker.
- Replaced all `sessionStorage` usage with an in-memory `Map` on the plugin instance, using Obsidian's own data lifecycle instead of browser storage APIs. Affected: HP tracker widget, spell slot pips, equipment toggle state, and session notes in the Interactive Character Sheet.

---

## v1.1.0

### New features
- **Interactive Character Sheet** — a full visual character sheet opens as an overlay when you click **⚔️ Open Interactive Character Sheet** at the top of any character note. The Markdown note remains untouched underneath.
  - **HP Tracker** — damage/heal buttons, quick ±1/5/10 adjustments, temp HP, color-coded bar, death save pips, change log
  - **Ability Scores** — click any score card to roll that ability check (animated d20 result + toast notification)
  - **Saving Throws** — click to roll; proficiency bonus applied automatically; proficient saves marked
  - **Skills** — all 18 skills with correct modifiers; expertise (★) and proficiency (●) shown; click to roll
  - **Actions & Attacks** — ATK and DMG roll buttons per weapon/cantrip; damage absorbed by temp HP correctly
  - **Spell Slots** — interactive pips per spell level; click to use/restore; Short/Long Rest button per level; state persists in session
  - **Spells** — expandable list grouped by level; click a spell to reveal description (from DnD Beyond data or 5etools if enabled)
  - **Equipment** — toggle equipped/unequipped per item with visual feedback; state persists in session
  - **Features & Traits** — expandable cards for racial traits and feats with optional 5etools description fetch
  - **Session Notes** — inline editable text area; content saved to session storage
  - **Roll Log** — live feed of every roll made on the sheet (d20 checks, saves, skills, attacks, damage)
  - **Currency** — color-coded coin display (CP/SP/EP/GP/PP)
  - **Proficiencies** — chip list of all proficiencies and languages
- **5etools integration** (disabled by default) — configure a self-hosted 5etools base URL in settings to fetch rich descriptions for spells, items, weapons, class features, and racial traits directly in the sheet. A 📖 button appears next to each relevant entry when enabled.

- **HP Tracker Modal** — persistent per-character health tracking during a session.
  - Visual HP bar (color-coded: green/yellow/red based on health %)
  - Current HP input field + quick adjust buttons (±1, ±5)
  - Temporary HP tracking (displayed alongside current)
  - Max HP configuration (useful for level-up changes)
  - Supports multiple characters — HP tracking is keyed per character and persists across the session

- **Enhanced Dice Roller** — new filtering, export, and statistics features.
  - **Filter by die type** — dropdown to show only d4, d6, d20, etc. History stats update to match the filter
  - **Export CSV** — download roll history as a spreadsheet-ready CSV file
  - **Copy to Clipboard** — formatted history for pasting into Discord, notes, or other apps
  - **Live Statistics** — average, max, min, and mode displayed below the history. For d20 rolls, shows count of Nat 20+ (🎉) and Nat 1 (💀)

### Removed
- **Character Roll Sheet** — the legacy roll sheet modal and its commands (*Open Character Roll Sheet*, *Open Roll Sheet for active character note*) and ribbon icon have been removed. All rolling is now handled by the Interactive Character Sheet, which covers the same functionality with a much richer interface.
- **Open HP Tracker command** — removed as a standalone command. HP tracking is available directly in the Interactive Character Sheet and via the inline HP tracker widget embedded in every character note.

### Settings changes
- New toggle: **Enable 5etools integration** (default: off)
- New text field: **5etools base URL** (default: `https://5e.tools`)

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
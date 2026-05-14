import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	TFile,
} from "obsidian";

interface DnDBeyondImporterSettings {
	outputFolder: string;
	includeSpells: boolean;
	includeEquipment: boolean;
	includeFeatures: boolean;
	includeBackstory: boolean;
}

interface DiceRoll {
	die: string;
	result: number;
	timestamp: string;
}

const DEFAULT_SETTINGS: DnDBeyondImporterSettings = {
	outputFolder: "Characters",
	includeSpells: true,
	includeEquipment: true,
	includeFeatures: true,
	includeBackstory: true,
};

// ─── Data helpers ─────────────────────────────────────────────────────────────

function modStr(score: number): string {
	const mod = Math.floor((score - 10) / 2);
	return mod >= 0 ? `+${mod}` : `${mod}`;
}

function profBonus(level: number): number {
	return Math.ceil(level / 4) + 1;
}

function getStatValue(
	stats: any[],
	overrides: any[],
	bonuses: any[],
	id: number
): number {
	const base = stats.find((s: any) => s.id === id)?.value ?? 10;
	const override = overrides.find((s: any) => s.id === id)?.value;
	if (override != null) return override;
	const bonus = bonuses
		.filter((b: any) => b.id === id)
		.reduce((acc: number, b: any) => acc + (b.value ?? 0), 0);
	return base + bonus;
}

function calcHP(char: any): { max: number; current: number; temp: number } {
	const base = char.baseHitPoints ?? 0;
	const bonus = char.bonusHitPoints ?? 0;
	const override = char.overrideHitPoints;
	const removedHp = char.removedHitPoints ?? 0;
	const temp = char.temporaryHitPoints ?? 0;
	const max = override != null ? override : base + bonus;
	return { max, current: max - removedHp, temp };
}

function calcLevel(classes: any[]): number {
	return classes.reduce((sum: number, c: any) => sum + (c.level ?? 0), 0);
}

function calcAC(char: any, dexScore: number): number {
	const dexMod = Math.floor((dexScore - 10) / 2);
	let bestAC = 10 + dexMod;
	for (const item of char.inventory ?? []) {
		const def = item.definition;
		if (!def || !item.equipped) continue;
		if (def.armorClass) {
			const base = def.armorClass;
			const addDex = def.armorTypeId !== 3;
			const maxDex = def.armorTypeId === 2 ? 2 : 999;
			const ac = base + (addDex ? Math.min(dexMod, maxDex) : 0);
			if (ac > bestAC) bestAC = ac;
		}
	}
	return bestAC;
}

function alignmentName(id: number): string {
	const map: Record<number, string> = {
		1: "Lawful Good", 2: "Neutral Good", 3: "Chaotic Good",
		4: "Lawful Neutral", 5: "True Neutral", 6: "Chaotic Neutral",
		7: "Lawful Evil", 8: "Neutral Evil", 9: "Chaotic Evil",
	};
	return map[id] ?? "Unaligned";
}

function activationTypeName(id: number): string {
	const map: Record<number, string> = {
		1: "Action", 2: "No Action", 3: "Bonus Action",
		4: "Reaction", 6: "Minute(s)", 7: "Hour(s)",
	};
	return map[id] ?? "Action";
}

function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/li>/gi, "\n")
		.replace(/<li>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.trim();
}

function extractCharacterId(url: string): string | null {
	const match = url.match(/\/characters\/(\d+)/);
	if (match) return match[1];
	if (/^\d+$/.test(url.trim())) return url.trim();
	return null;
}

// ─── Markdown builder ─────────────────────────────────────────────────────────

function buildMarkdown(
	data: any,
	settings: DnDBeyondImporterSettings
): string {
	const char = data.data;
	if (!char) throw new Error("Unexpected API response structure");

	const classes: any[] = char.classes ?? [];
	const totalLevel = calcLevel(classes);
	const pb = profBonus(totalLevel);

	const rawStats = {
		str: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 1),
		dex: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 2),
		con: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 3),
		int: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 4),
		wis: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 5),
		cha: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 6),
	};

	const hp = calcHP(char);
	const ac = calcAC(char, rawStats.dex);

	const raceName: string = char.race?.fullName ?? char.race?.baseName ?? "Unknown Race";
	const classString = classes
		.map((c: any) => `${c.definition?.name ?? "Unknown"} ${c.level}`)
		.join(" / ");
	const background: string = char.background?.definition?.name ?? "Unknown Background";
	const alignment: string =
		char.alignmentId != null ? alignmentName(char.alignmentId) : "Unaligned";

	const tags = ["dnd-character", raceName.toLowerCase().replace(/\s+/g, "-")];
	classes.forEach((c: any) => {
		if (c.definition?.name) tags.push(c.definition.name.toLowerCase());
	});

	// ── YAML Front Matter ───────────────────────────────────────────────────
	let md = `---
name: "${char.name}"
race: "${raceName}"
class: "${classString}"
level: ${totalLevel}
background: "${background}"
alignment: "${alignment}"
xp: ${char.currentXp ?? 0}
hp_max: ${hp.max}
hp_current: ${hp.current}
hp_temp: ${hp.temp}
ac: ${ac}
speed: ${char.race?.weightSpeeds?.normal?.walk ?? 30}
proficiency_bonus: ${pb}
str: ${rawStats.str}
dex: ${rawStats.dex}
con: ${rawStats.con}
int: ${rawStats.int}
wis: ${rawStats.wis}
cha: ${rawStats.cha}
tags: [${tags.map((t) => `"${t}"`).join(", ")}]
dndbeyond_id: ${char.id}
---

`;

	// ── Title ───────────────────────────────────────────────────────────────
	md += `# ${char.name}\n\n`;
	if (char.avatarUrl) md += `![${char.name}](${char.avatarUrl})\n\n`;
	md += `> **${classString}** • ${raceName} • Level ${totalLevel}\n`;
	md += `> *${background} — ${alignment}*\n\n`;

	// ── Core Stats ──────────────────────────────────────────────────────────
	md += `## Core Stats\n\n`;
	md += `| HP | AC | Speed | Initiative | Proficiency Bonus |\n`;
	md += `|:---:|:---:|:---:|:---:|:---:|\n`;
	md += `| ${hp.current} / ${hp.max}${hp.temp > 0 ? ` (+${hp.temp} temp)` : ""} | ${ac} | ${char.race?.weightSpeeds?.normal?.walk ?? 30} ft | ${modStr(rawStats.dex)} | +${pb} |\n\n`;

	// ── Ability Scores ──────────────────────────────────────────────────────
	md += `## Ability Scores\n\n`;
	md += `| STR | DEX | CON | INT | WIS | CHA |\n`;
	md += `|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
	md += `| ${rawStats.str} (${modStr(rawStats.str)}) | ${rawStats.dex} (${modStr(rawStats.dex)}) | ${rawStats.con} (${modStr(rawStats.con)}) | ${rawStats.int} (${modStr(rawStats.int)}) | ${rawStats.wis} (${modStr(rawStats.wis)}) | ${rawStats.cha} (${modStr(rawStats.cha)}) |\n\n`;

	// ── Saving Throws ───────────────────────────────────────────────────────
	md += buildSavingThrows(char, rawStats, pb);

	// ── Skills ──────────────────────────────────────────────────────────────
	md += buildSkillsSection(char, rawStats, pb);

	// ── Proficiencies & Languages ───────────────────────────────────────────
	md += buildProficiencies(char);

	// ── Currency ────────────────────────────────────────────────────────────
	const curr = char.currencies;
	if (curr) {
		md += `## Currency\n\n`;
		md += `| CP | SP | EP | GP | PP |\n`;
		md += `|:---:|:---:|:---:|:---:|:---:|\n`;
		md += `| ${curr.cp ?? 0} | ${curr.sp ?? 0} | ${curr.ep ?? 0} | ${curr.gp ?? 0} | ${curr.pp ?? 0} |\n\n`;
	}

	// ── Equipment ───────────────────────────────────────────────────────────
	if (settings.includeEquipment && char.inventory?.length) {
		md += buildEquipment(char.inventory);
	}

	// ── Features & Traits ───────────────────────────────────────────────────
	if (settings.includeFeatures) {
		md += buildFeatures(char);
	}

	// ── Spells ──────────────────────────────────────────────────────────────
	if (settings.includeSpells) {
		const spellSection = buildSpells(char);
		if (spellSection) md += spellSection;
	}

	// ── Backstory & Notes ───────────────────────────────────────────────────
	if (settings.includeBackstory) {
		md += buildBackstory(char);
	}

	// ── Player Notes ────────────────────────────────────────────────────────
	md += `## Session Notes\n\n*Add your notes here.*\n\n`;
	md += `---\n*Imported from [D&D Beyond](https://www.dndbeyond.com/characters/${char.id}) — Level ${totalLevel} ${char.name}*\n`;

	return md;
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildSavingThrows(char: any, stats: any, pb: number): string {
	const statKeys = [
		{ key: "str", label: "STR", subType: "strength-saving-throws" },
		{ key: "dex", label: "DEX", subType: "dexterity-saving-throws" },
		{ key: "con", label: "CON", subType: "constitution-saving-throws" },
		{ key: "int", label: "INT", subType: "intelligence-saving-throws" },
		{ key: "wis", label: "WIS", subType: "wisdom-saving-throws" },
		{ key: "cha", label: "CHA", subType: "charisma-saving-throws" },
	];

	const allMods: any[] = [
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];

	const cells: string[] = statKeys.map(({ key, subType }) => {
		const statVal = stats[key];
		const base = Math.floor((statVal - 10) / 2);
		const isProficient = allMods.some(
			(m: any) => m.type === "proficiency" && m.subType === subType
		);
		const total = isProficient ? base + pb : base;
		const str = total >= 0 ? `+${total}` : `${total}`;
		return isProficient ? `**${str}** ✓` : str;
	});

	let md = `## Saving Throws\n\n`;
	md += `| STR | DEX | CON | INT | WIS | CHA |\n`;
	md += `|:---:|:---:|:---:|:---:|:---:|:---:|\n`;
	md += `| ${cells.join(" | ")} |\n\n`;
	return md;
}

function buildSkillsSection(char: any, stats: any, pb: number): string {
	const skillDefs = [
		{ name: "Acrobatics", stat: "dex", key: "acrobatics" },
		{ name: "Animal Handling", stat: "wis", key: "animal-handling" },
		{ name: "Arcana", stat: "int", key: "arcana" },
		{ name: "Athletics", stat: "str", key: "athletics" },
		{ name: "Deception", stat: "cha", key: "deception" },
		{ name: "History", stat: "int", key: "history" },
		{ name: "Insight", stat: "wis", key: "insight" },
		{ name: "Intimidation", stat: "cha", key: "intimidation" },
		{ name: "Investigation", stat: "int", key: "investigation" },
		{ name: "Medicine", stat: "wis", key: "medicine" },
		{ name: "Nature", stat: "int", key: "nature" },
		{ name: "Perception", stat: "wis", key: "perception" },
		{ name: "Performance", stat: "cha", key: "performance" },
		{ name: "Persuasion", stat: "cha", key: "persuasion" },
		{ name: "Religion", stat: "int", key: "religion" },
		{ name: "Sleight of Hand", stat: "dex", key: "sleight-of-hand" },
		{ name: "Stealth", stat: "dex", key: "stealth" },
		{ name: "Survival", stat: "wis", key: "survival" },
	];

	const allMods: any[] = [
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];

	const statMap: Record<string, number> = stats;

	let md = `## Skills\n\n`;
	md += `| Skill | Stat | Bonus |\n`;
	md += `|:---|:---:|:---:|\n`;

	for (const skill of skillDefs) {
		const statVal = statMap[skill.stat];
		const base = Math.floor((statVal - 10) / 2);
		const expertise = allMods.some(
			(m: any) => m.type === "expertise" && m.subType === skill.key
		);
		const prof = allMods.some(
			(m: any) => m.type === "proficiency" && m.subType === skill.key
		);
		let bonus = base;
		if (expertise) bonus += pb * 2;
		else if (prof) bonus += pb;

		const bonusStr = bonus >= 0 ? `+${bonus}` : `${bonus}`;
		const marker = expertise ? " ★" : prof ? " ✓" : "";
		md += `| ${skill.name}${marker} | ${skill.stat.toUpperCase()} | ${bonusStr} |\n`;
	}

	md += "\n*✓ = Proficient, ★ = Expertise*\n\n";
	return md;
}

function buildProficiencies(char: any): string {
	const allMods: any[] = [
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];

	const collect = (filterFn: (m: any) => boolean) =>
		[
			...new Set(
				allMods
					.filter(filterFn)
					.map((m: any) => m.friendlySubtypeName ?? m.subType)
					.filter(Boolean)
			),
		];

	const languages = collect((m) => m.type === "language");
	const armors = collect(
		(m) => m.type === "proficiency" && (m.subType ?? "").includes("armor")
	);
	const weapons = collect(
		(m) => m.type === "proficiency" && (m.subType ?? "").includes("weapon")
	);
	const tools = collect(
		(m) => m.type === "proficiency" && (m.subType ?? "").includes("tool")
	);

	let md = `## Proficiencies & Languages\n\n`;
	if (languages.length) md += `**Languages:** ${languages.join(", ")}\n\n`;
	if (armors.length) md += `**Armor:** ${armors.join(", ")}\n\n`;
	if (weapons.length) md += `**Weapons:** ${weapons.join(", ")}\n\n`;
	if (tools.length) md += `**Tools:** ${tools.join(", ")}\n\n`;

	return md;
}

function buildEquipment(inventory: any[]): string {
	let md = `## Equipment\n\n`;
	md += `| Item | Qty | Equipped | Weight |\n`;
	md += `|:---|:---:|:---:|:---:|\n`;

	for (const item of inventory) {
		const def = item.definition;
		if (!def) continue;
		const name = def.name ?? "Unknown Item";
		const qty = item.quantity ?? 1;
		const equipped = item.equipped ? "✓" : "—";
		const weight =
			def.weight != null ? `${(def.weight * qty).toFixed(1)} lbs` : "—";
		md += `| ${name} | ${qty} | ${equipped} | ${weight} |\n`;
	}

	md += "\n";
	return md;
}

function buildFeatures(char: any): string {
	let md = `## Features & Traits\n\n`;

	const raceTraits: any[] = char.race?.racialTraits ?? [];
	if (raceTraits.length) {
		md += `### Racial Traits\n\n`;
		for (const trait of raceTraits) {
			const def = trait.definition;
			if (!def) continue;
			md += `**${def.name}**\n`;
			if (def.description) md += `${stripHtml(def.description)}\n`;
			md += "\n";
		}
	}

	const feats: any[] = char.feats ?? [];
	if (feats.length) {
		md += `### Feats\n\n`;
		for (const feat of feats) {
			const def = feat.definition;
			if (!def) continue;
			md += `**${def.name}**\n`;
			if (def.description) md += `${stripHtml(def.description)}\n`;
			md += "\n";
		}
	}

	const t = char.traits;
	if (t) {
		md += `### Character Traits\n\n`;
		if (t.personalityTraits) md += `**Personality:** ${t.personalityTraits}\n\n`;
		if (t.ideals) md += `**Ideals:** ${t.ideals}\n\n`;
		if (t.bonds) md += `**Bonds:** ${t.bonds}\n\n`;
		if (t.flaws) md += `**Flaws:** ${t.flaws}\n\n`;
		if (t.appearance) md += `**Appearance:** ${t.appearance}\n\n`;
	}

	return md;
}

function buildSpells(char: any): string {
	const allSpells: any[] = [];

	if (Array.isArray(char.classSpells)) {
		for (const cs of char.classSpells) {
			for (const spell of cs.spells ?? []) allSpells.push(spell);
		}
	}

	for (const src of ["race", "background", "feat", "class", "item"]) {
		for (const spell of char.spells?.[src] ?? []) allSpells.push(spell);
	}

	if (!allSpells.length) return "";

	let md = `## Spells\n\n`;

	const byLevel: Map<number, any[]> = new Map();
	for (const spell of allSpells) {
		const lvl = spell.definition?.level ?? 0;
		if (!byLevel.has(lvl)) byLevel.set(lvl, []);
		byLevel.get(lvl)!.push(spell);
	}

	const levelNames = [
		"Cantrips", "1st Level", "2nd Level", "3rd Level",
		"4th Level", "5th Level", "6th Level", "7th Level",
		"8th Level", "9th Level",
	];

	for (const [lvl, spells] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
		md += `### ${levelNames[lvl] ?? `Level ${lvl}`}\n\n`;
		md += `| Spell | School | Cast Time | Range | Conc. | Prepared |\n`;
		md += `|:---|:---|:---|:---|:---:|:---:|\n`;
		for (const spell of spells) {
			const def = spell.definition;
			if (!def) continue;
			const school = def.school ?? "—";
			const castTime =
				def.activation?.activationTime != null
					? `${def.activation.activationTime} ${activationTypeName(def.activation.activationType)}`
					: "—";
			const range =
				def.range?.rangeValue != null
					? `${def.range.rangeValue} ft`
					: def.range?.origin ?? "—";
			const conc = def.concentration ? "✓" : "—";
			const prepared = spell.prepared ? "✓" : "—";
			md += `| **${def.name}** | ${school} | ${castTime} | ${range} | ${conc} | ${prepared} |\n`;
		}
		md += "\n";
	}

	// Spell slots
	const spellSlots: any = char.spellSlots;
	if (spellSlots) {
		const slots = Array.isArray(spellSlots)
			? spellSlots
			: Object.values(spellSlots);
		const usefulSlots = (slots as any[]).filter((s) => s.max);
		if (usefulSlots.length) {
			md += `### Spell Slots\n\n`;
			md += `| Level | Used | Max |\n`;
			md += `|:---:|:---:|:---:|\n`;
			for (const slot of usefulSlots) {
				md += `| ${slot.level} | ${slot.used ?? 0} | ${slot.max} |\n`;
			}
			md += "\n";
		}
	}

	return md;
}

function buildBackstory(char: any): string {
	const notes: any = char.notes;
	if (!notes) return "";

	let md = `## Backstory & Notes\n\n`;
	if (notes.backstory) md += `### Backstory\n\n${stripHtml(notes.backstory)}\n\n`;
	if (notes.personalityTraits)
		md += `**Personality Traits:** ${notes.personalityTraits}\n\n`;
	if (notes.allies) md += `**Allies & Organizations:** ${notes.allies}\n\n`;
	if (notes.enemies) md += `**Enemies:** ${notes.enemies}\n\n`;
	if (notes.otherNotes) md += `**Other Notes:** ${notes.otherNotes}\n\n`;

	return md;
}

// ─── Plugin class ─────────────────────────────────────────────────────────────

export default class DnDBeyondImporterPlugin extends Plugin {
	settings: DnDBeyondImporterSettings;
	rollHistory: DiceRoll[] = [];

	async onload() {
		await this.loadSettings();

		this.addRibbonIcon("sword", "Import D&D Beyond Character", () => {
			new ImportModal(this.app, this).open();
		});

		this.addRibbonIcon("dice", "Dice Roller", () => {
			new DiceRollerModal(this.app, this).open();
		});

		this.addCommand({
			id: "import-dndbeyond-character",
			name: "Import character from D&D Beyond",
			callback: () => {
				new ImportModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "open-dice-roller",
			name: "Open Dice Roller",
			callback: () => {
				new DiceRollerModal(this.app, this).open();
			},
		});

		this.addSettingTab(new DnDBeyondSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async importCharacter(url: string): Promise<void> {
		const charId = extractCharacterId(url);
		if (!charId) {
			new Notice("❌ Could not extract a character ID from that URL.");
			return;
		}

		new Notice(`⏳ Fetching character ${charId}…`);

		let data: any;
		try {
			const apiUrl = `https://character-service.dndbeyond.com/character/v5/character/${charId}`;
			const resp = await requestUrl({
				url: apiUrl,
				headers: { Accept: "application/json" },
			});
			if (resp.status < 200 || resp.status >= 300)
				throw new Error(`HTTP ${resp.status}`);
			data = resp.json;
		} catch (e: any) {
			new Notice(`❌ Failed to fetch character: ${e.message}`);
			console.error("[DnD Beyond Importer]", e);
			return;
		}

		let markdown: string;
		try {
			markdown = buildMarkdown(data, this.settings);
		} catch (e: any) {
			new Notice(`❌ Failed to parse character data: ${e.message}`);
			console.error("[DnD Beyond Importer]", e);
			return;
		}

		const charName: string = data?.data?.name ?? `Character-${charId}`;
		const safeName = charName.replace(/[\\/:*?"<>|]/g, "-");

		const folder = this.settings.outputFolder.trim();
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder);
		}

		const filePath = folder ? `${folder}/${safeName}.md` : `${safeName}.md`;
		const existing = this.app.vault.getAbstractFileByPath(filePath);

		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, markdown);
			new Notice(`✅ Updated "${safeName}.md"`);
		} else {
			await this.app.vault.create(filePath, markdown);
			new Notice(`✅ Created "${safeName}.md"`);
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			const leaf = this.app.workspace.getLeaf(true);
			await leaf.openFile(file);
		}
	}
}

// ─── Import Modal ─────────────────────────────────────────────────────────────

class ImportModal extends Modal {
	plugin: DnDBeyondImporterPlugin;
	private urlValue = "";

	constructor(app: App, plugin: DnDBeyondImporterPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Import D&D Beyond Character" });
		contentEl.createEl("p", {
			text: "Paste the character URL or numeric ID. The character must be set to Public on D&D Beyond.",
			cls: "setting-item-description",
		});

		const input = contentEl.createEl("input", {
			type: "text",
			placeholder: "https://www.dndbeyond.com/characters/137202151/…",
		});
		Object.assign(input.style, {
			width: "100%",
			marginBottom: "12px",
			padding: "6px 8px",
			fontSize: "14px",
		});

		input.addEventListener("input", (e) => {
			this.urlValue = (e.target as HTMLInputElement).value;
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.submit();
		});

		const btnRow = contentEl.createEl("div");
		Object.assign(btnRow.style, {
			display: "flex", gap: "8px", justifyContent: "flex-end",
		});

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const importBtn = btnRow.createEl("button", {
			text: "Import", cls: "mod-cta",
		});
		importBtn.addEventListener("click", () => this.submit());

		setTimeout(() => input.focus(), 50);
	}

	private async submit() {
		this.close();
		await this.plugin.importCharacter(this.urlValue.trim());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── Dice Roller Modal ────────────────────────────────────────────────────────

class DiceRollerModal extends Modal {
	plugin: DnDBeyondImporterPlugin;

	constructor(app: App, plugin: DnDBeyondImporterPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "🎲 Dice Roller" });

		// ── Die buttons ─────────────────────────────────────────────────────
		const dice: { label: string; sides: number }[] = [
			{ label: "d4", sides: 4 },
			{ label: "d6", sides: 6 },
			{ label: "d8", sides: 8 },
			{ label: "d10", sides: 10 },
			{ label: "d12", sides: 12 },
			{ label: "d20", sides: 20 },
			{ label: "d100", sides: 100 },
		];

		const btnGrid = contentEl.createEl("div");
		Object.assign(btnGrid.style, {
			display: "flex",
			flexWrap: "wrap",
			gap: "8px",
			marginBottom: "16px",
		});

		// ── Result display ───────────────────────────────────────────────────
		const resultEl = contentEl.createEl("div");
		Object.assign(resultEl.style, {
			textAlign: "center",
			fontSize: "48px",
			fontWeight: "bold",
			margin: "12px 0",
			minHeight: "64px",
			letterSpacing: "2px",
		});
		resultEl.setText("—");

		const subtitleEl = contentEl.createEl("div");
		Object.assign(subtitleEl.style, {
			textAlign: "center",
			fontSize: "13px",
			color: "var(--text-muted)",
			marginBottom: "16px",
		});

		for (const die of dice) {
			const btn = btnGrid.createEl("button", {
				text: die.label,
				cls: "mod-cta",
			});
			Object.assign(btn.style, {
				flex: "1 1 calc(14% - 8px)",
				minWidth: "52px",
				padding: "10px 4px",
				fontSize: "15px",
				fontWeight: "600",
			});
			btn.addEventListener("click", () => {
				const roll = Math.floor(Math.random() * die.sides) + 1;
				const now = new Date();
				const timestamp = now.toLocaleString();

				// Save to history
				this.plugin.rollHistory.unshift({
					die: die.label,
					result: roll,
					timestamp,
				});
				// Keep last 50 rolls
				if (this.plugin.rollHistory.length > 50)
					this.plugin.rollHistory.length = 50;

				// Show result in modal
				resultEl.setText(`${roll}`);
				subtitleEl.setText(`${die.label} rolled at ${timestamp}`);

				// Obsidian notification
				new Notice(`🎲 ${die.label}: ${roll}`, 4000);

				// Refresh history list
				renderHistory();
			});
		}

		// ── History ──────────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Roll History" });

		const historyEl = contentEl.createEl("div");
		Object.assign(historyEl.style, {
			maxHeight: "200px",
			overflowY: "auto",
			border: "1px solid var(--background-modifier-border)",
			borderRadius: "6px",
			padding: "6px 8px",
		});

		const clearBtn = contentEl.createEl("button", { text: "Clear History" });
		Object.assign(clearBtn.style, {
			marginTop: "8px",
			fontSize: "12px",
		});
		clearBtn.addEventListener("click", () => {
			this.plugin.rollHistory = [];
			renderHistory();
		});

		const renderHistory = () => {
			historyEl.empty();
			if (this.plugin.rollHistory.length === 0) {
				const empty = historyEl.createEl("div", { text: "No rolls yet." });
				Object.assign(empty.style, {
					color: "var(--text-muted)",
					fontSize: "13px",
					padding: "4px 0",
				});
				return;
			}
			for (const entry of this.plugin.rollHistory) {
				const row = historyEl.createEl("div");
				Object.assign(row.style, {
					display: "flex",
					justifyContent: "space-between",
					padding: "3px 0",
					borderBottom: "1px solid var(--background-modifier-border)",
					fontSize: "13px",
				});
				row.createEl("span", {
					text: `🎲 ${entry.die} → ${entry.result}`,
				});
				const ts = row.createEl("span", { text: entry.timestamp });
				Object.assign(ts.style, { color: "var(--text-muted)" });
			}
		};

		renderHistory();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class DnDBeyondSettingTab extends PluginSettingTab {
	plugin: DnDBeyondImporterPlugin;

	constructor(app: App, plugin: DnDBeyondImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "D&D Beyond Importer" });

		new Setting(containerEl)
			.setName("Output folder")
			.setDesc("Vault folder where character notes are saved (leave blank for vault root).")
			.addText((text) =>
				text
					.setPlaceholder("Characters")
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async (value) => {
						this.plugin.settings.outputFolder = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include spells")
			.setDesc("Import the full spell list and spell slots.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeSpells)
					.onChange(async (value) => {
						this.plugin.settings.includeSpells = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include equipment")
			.setDesc("Import the inventory / equipment table.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeEquipment)
					.onChange(async (value) => {
						this.plugin.settings.includeEquipment = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include features & traits")
			.setDesc("Import racial traits, feats and character personality traits.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeFeatures)
					.onChange(async (value) => {
						this.plugin.settings.includeFeatures = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include backstory & notes")
			.setDesc("Import character backstory and campaign notes from D&D Beyond.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeBackstory)
					.onChange(async (value) => {
						this.plugin.settings.includeBackstory = value;
						await this.plugin.saveSettings();
					})
			);
	}
}

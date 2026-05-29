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
	modifier: number;
	label: string;
	timestamp: string;
}

interface CharacterAction {
	name: string;
	attackBonus: number | null;
	damageDice: string | null;
	damageBonus: number;
	range: string;
	notes: string;
	isSpell: boolean;
}

// ─── Typed interfaces for D&D Beyond API response ─────────────────────────────

interface DdbStat {
	id: number;
	value: number | null;
}

interface DdbModifier {
	type: string;
	subType: string;
	friendlySubtypeName?: string;
	value?: number;
	id?: number;
}

interface DdbModifiers {
	class?: DdbModifier[];
	race?: DdbModifier[];
	background?: DdbModifier[];
	feat?: DdbModifier[];
}

interface DdbDefinition {
	name?: string;
	description?: string;
	level?: number;
	school?: string;
	activation?: { activationTime?: number; activationType?: number };
	range?: { rangeValue?: number; origin?: string };
	concentration?: boolean;
	armorClass?: number;
	armorTypeId?: number;
	weight?: number;
}

interface DdbSpell {
	definition?: DdbDefinition;
	prepared?: boolean;
}

interface DdbClassSpell {
	spells?: DdbSpell[];
}

interface DdbInventoryItem {
	definition?: DdbDefinition;
	equipped?: boolean;
	quantity?: number;
}

interface DdbRacialTrait {
	definition?: DdbDefinition;
}

interface DdbFeat {
	definition?: DdbDefinition;
}

interface DdbRace {
	fullName?: string;
	baseName?: string;
	weightSpeeds?: { normal?: { walk?: number } };
	racialTraits?: DdbRacialTrait[];
}

interface DdbClass {
	level?: number;
	definition?: { name?: string };
	stats?: DdbStat[];
	overrideStats?: DdbStat[];
	bonusStats?: DdbStat[];
	modifiers?: DdbModifiers;
}

interface DdbBackground {
	definition?: { name?: string };
}

interface DdbTraits {
	personalityTraits?: string;
	ideals?: string;
	bonds?: string;
	flaws?: string;
	appearance?: string;
}

interface DdbNotes {
	backstory?: string;
	personalityTraits?: string;
	allies?: string;
	enemies?: string;
	otherNotes?: string;
}

interface DdbSpellSlot {
	level?: number;
	used?: number;
	max?: number;
}

interface DdbCurrencies {
	cp?: number;
	sp?: number;
	ep?: number;
	gp?: number;
	pp?: number;
}

interface DdbCharacter {
	id: number;
	name?: string;
	avatarUrl?: string;
	currentXp?: number;
	alignmentId?: number;
	baseHitPoints?: number;
	bonusHitPoints?: number;
	overrideHitPoints?: number;
	removedHitPoints?: number;
	temporaryHitPoints?: number;
	race?: DdbRace;
	classes?: DdbClass[];
	stats?: DdbStat[];
	overrideStats?: DdbStat[];
	bonusStats?: DdbStat[];
	modifiers?: DdbModifiers;
	background?: DdbBackground;
	inventory?: DdbInventoryItem[];
	feats?: DdbFeat[];
	traits?: DdbTraits;
	currencies?: DdbCurrencies;
	classSpells?: DdbClassSpell[];
	spells?: Record<string, DdbSpell[]>;
	spellSlots?: DdbSpellSlot[] | Record<string, DdbSpellSlot>;
	notes?: DdbNotes;
}

interface DdbApiResponse {
	data?: DdbCharacter;
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
	stats: DdbStat[],
	overrides: DdbStat[],
	bonuses: DdbStat[],
	id: number
): number {
	const base = stats.find((s) => s.id === id)?.value ?? 10;
	const override = overrides.find((s) => s.id === id)?.value;
	if (override != null) return override;
	const bonus = bonuses
		.filter((b) => b.id === id)
		.reduce((acc, b) => acc + (b.value ?? 0), 0);
	return (base ?? 10) + bonus;
}

function calcHP(char: DdbCharacter): { max: number; current: number; temp: number } {
	const base = char.baseHitPoints ?? 0;
	const bonus = char.bonusHitPoints ?? 0;
	const override = char.overrideHitPoints;
	const removedHp = char.removedHitPoints ?? 0;
	const temp = char.temporaryHitPoints ?? 0;
	const max = override != null ? override : base + bonus;
	return { max, current: max - removedHp, temp };
}

function calcLevel(classes: DdbClass[]): number {
	return classes.reduce((sum, c) => sum + (c.level ?? 0), 0);
}

function calcAC(char: DdbCharacter, dexScore: number): number {
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
	data: DdbApiResponse,
	settings: DnDBeyondImporterSettings
): string {
	const char = data.data;
	if (!char) throw new Error("Unexpected API response structure");

	const classes: DdbClass[] = char.classes ?? [];
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
		.map((c) => `${c.definition?.name ?? "Unknown"} ${c.level ?? 0}`)
		.join(" / ");
	const background: string = char.background?.definition?.name ?? "Unknown Background";
	const alignment: string =
		char.alignmentId != null ? alignmentName(char.alignmentId) : "Unaligned";

	const tags = ["dnd-character", raceName.toLowerCase().replace(/\s+/g, "-")];
	classes.forEach((c) => {
		const cname = c.definition?.name;
		if (cname) tags.push(cname.toLowerCase());
	});

	// ── YAML Front Matter ───────────────────────────────────────────────────
	let md = `---
name: "${char.name ?? ""}"
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
	md += `# ${char.name ?? "Unknown Character"}\n\n`;
	if (char.avatarUrl) md += `![${char.name ?? ""}](${char.avatarUrl})\n\n`;
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
	if (settings.includeEquipment && (char.inventory?.length ?? 0) > 0) {
		md += buildEquipment(char.inventory ?? []);
	}

	// ── Actions & Attacks ───────────────────────────────────────────────────
	const actionList = extractActions(char, rawStats, pb);
	if (actionList.length) {
		md += buildActionsSection(actionList);
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
	md += `---\n*Imported from [D&D Beyond](https://www.dndbeyond.com/characters/${char.id}) — Level ${totalLevel} ${char.name ?? ""}*\n`;

	return md;
}

// ─── Section builders ─────────────────────────────────────────────────────────

function buildSavingThrows(
	char: DdbCharacter,
	stats: Record<string, number>,
	pb: number
): string {
	const statKeys = [
		{ key: "str", label: "STR", subType: "strength-saving-throws" },
		{ key: "dex", label: "DEX", subType: "dexterity-saving-throws" },
		{ key: "con", label: "CON", subType: "constitution-saving-throws" },
		{ key: "int", label: "INT", subType: "intelligence-saving-throws" },
		{ key: "wis", label: "WIS", subType: "wisdom-saving-throws" },
		{ key: "cha", label: "CHA", subType: "charisma-saving-throws" },
	];

	const allMods: DdbModifier[] = [
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];

	const cells: string[] = statKeys.map(({ key, subType }) => {
		const statVal = stats[key] ?? 10;
		const base = Math.floor((statVal - 10) / 2);
		const isProficient = allMods.some(
			(m) => m.type === "proficiency" && m.subType === subType
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

function buildSkillsSection(
	char: DdbCharacter,
	stats: Record<string, number>,
	pb: number
): string {
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

	const allMods: DdbModifier[] = [
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];

	let md = `## Skills\n\n`;
	md += `| Skill | Stat | Bonus |\n`;
	md += `|:---|:---:|:---:|\n`;

	for (const skill of skillDefs) {
		const statVal = stats[skill.stat] ?? 10;
		const base = Math.floor((statVal - 10) / 2);
		const expertise = allMods.some(
			(m) => m.type === "expertise" && m.subType === skill.key
		);
		const prof = allMods.some(
			(m) => m.type === "proficiency" && m.subType === skill.key
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

function buildProficiencies(char: DdbCharacter): string {
	const allMods: DdbModifier[] = [
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];

	const collect = (filterFn: (m: DdbModifier) => boolean): string[] =>
		[
			...new Set(
				allMods
					.filter(filterFn)
					.map((m) => m.friendlySubtypeName ?? m.subType)
					.filter(Boolean)
			),
		] as string[];

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

function buildEquipment(inventory: DdbInventoryItem[]): string {
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

function buildActionsSection(actions: CharacterAction[]): string {
	let md = `## Actions & Attacks\n\n`;
	md += `| Name | ATK Bonus | Damage | Range | Notes |\n`;
	md += `|:---|:---:|:---|:---:|:---|\n`;
	for (const a of actions) {
		const atkStr = a.attackBonus != null
			? (a.attackBonus >= 0 ? `+${a.attackBonus}` : `${a.attackBonus}`)
			: "—";
		const dmgStr = a.damageDice
			? `${a.damageDice}${a.damageBonus !== 0 ? (a.damageBonus >= 0 ? `+${a.damageBonus}` : `${a.damageBonus}`) : ""}`
			: (a.damageBonus !== 0 ? `${a.damageBonus}` : "—");
		const prefix = a.isSpell ? "✨ " : "⚔️ ";
		md += `| ${prefix}${a.name} | ${atkStr} | ${dmgStr} | ${a.range} | ${a.notes || "—"} |\n`;
	}
	md += "\n";
	return md;
}

function buildFeatures(char: DdbCharacter): string {
	let md = `## Features & Traits\n\n`;

	const raceTraits: DdbRacialTrait[] = char.race?.racialTraits ?? [];
	if (raceTraits.length) {
		md += `### Racial Traits\n\n`;
		for (const trait of raceTraits) {
			const def = trait.definition;
			if (!def) continue;
			md += `**${def.name ?? ""}**\n`;
			if (def.description) md += `${stripHtml(def.description)}\n`;
			md += "\n";
		}
	}

	const feats: DdbFeat[] = char.feats ?? [];
	if (feats.length) {
		md += `### Feats\n\n`;
		for (const feat of feats) {
			const def = feat.definition;
			if (!def) continue;
			md += `**${def.name ?? ""}**\n`;
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

function buildSpells(char: DdbCharacter): string {
	const allSpells: DdbSpell[] = [];

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

	const byLevel: Map<number, DdbSpell[]> = new Map();
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
					? `${def.activation.activationTime} ${activationTypeName(def.activation.activationType ?? 1)}`
					: "—";
			const range =
				def.range?.rangeValue != null
					? `${def.range.rangeValue} ft`
					: def.range?.origin ?? "—";
			const conc = def.concentration ? "✓" : "—";
			const prepared = spell.prepared ? "✓" : "—";
			md += `| **${def.name ?? ""}** | ${school} | ${castTime} | ${range} | ${conc} | ${prepared} |\n`;
		}
		md += "\n";
	}

	// Spell slots
	const spellSlots = char.spellSlots;
	if (spellSlots) {
		const slots: DdbSpellSlot[] = Array.isArray(spellSlots)
			? spellSlots
			: Object.values(spellSlots);
		const usefulSlots = slots.filter((s) => s.max);
		if (usefulSlots.length) {
			md += `### Spell Slots\n\n`;
			md += `| Level | Used | Max |\n`;
			md += `|:---:|:---:|:---:|\n`;
			for (const slot of usefulSlots) {
				md += `| ${slot.level ?? "?"} | ${slot.used ?? 0} | ${slot.max ?? 0} |\n`;
			}
			md += "\n";
		}
	}

	return md;
}

function buildBackstory(char: DdbCharacter): string {
	const notes = char.notes;
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

// ─── Actions extractor ───────────────────────────────────────────────────────

function extractActions(char: DdbCharacter, stats: Record<string, number>, pb: number): CharacterAction[] {
	const actions: CharacterAction[] = [];
	const strMod = Math.floor((stats.str - 10) / 2);
	const dexMod = Math.floor((stats.dex - 10) / 2);

	const allMods: DdbModifier[] = [
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
	];
	for (const item of char.inventory ?? []) {
		const def = item.definition as (DdbDefinition & {
			weaponBehaviors?: Array<{attackType?: number; damage?: {diceString?: string; fixedValue?: number}; properties?: Array<{name?: string}>}>;
			isMonkWeapon?: boolean;
			weaponTypeRange?: number;
			categoryId?: number;
			damage?: { diceString?: string; fixedValue?: number };
			properties?: Array<{ name?: string }>;
		});
		if (!def || !item.equipped) continue;

		// Accept categoryId 1 (standard weapons) or items that have weaponBehaviors (custom/magic weapons)
		const hasWeaponBehaviors = Array.isArray(def.weaponBehaviors) && def.weaponBehaviors.length > 0;
		if (def.categoryId !== 1 && !hasWeaponBehaviors) continue;

		const isFinesse = def.properties?.some((p) => p.name === "Finesse") ?? false;
		const isRanged = def.weaponTypeRange === 2;
		const atkMod = isRanged ? dexMod : (isFinesse ? Math.max(strMod, dexMod) : strMod);
		const attackBonus = atkMod + pb;

		// Only use damage dice if explicitly defined on the item — homebrew items with no
		// damage field (e.g. utility weapons) are ATK-only and show no DMG roll.
		const dmgDice: string | null = def.damage?.diceString ?? null;
		const fixedVal: number | null = def.damage?.fixedValue ?? null;
		const dmgBonus = dmgDice != null || fixedVal != null ? atkMod + (fixedVal ?? 0) : 0;

		// Build range string — prefer explicit rangeValue, then properties, then defaults
		const rangeVal = def.range?.rangeValue;
		const propNames = (def.properties ?? []).map((p) => p.name ?? "").filter(Boolean);
		const rangeStr = rangeVal
			? `${rangeVal} ft`
			: (isRanged ? "Ranged" : "5 ft");

		actions.push({
			name: def.name ?? "Unknown Weapon",
			attackBonus,
			damageDice: dmgDice,
			damageBonus: dmgBonus,
			range: rangeStr,
			notes: propNames.join(", "),
			isSpell: false,
		});
	}

	// Unarmed strike always present
	const unarmedDmg = 1 + strMod;
	actions.push({
		name: "Unarmed Strike",
		attackBonus: strMod + pb,
		damageDice: null,
		damageBonus: unarmedDmg,
		range: "5 ft",
		notes: "Bludgeoning",
		isSpell: false,
	});

	// Cantrip attack spells
	const allSpells: DdbSpell[] = [];
	if (Array.isArray(char.classSpells)) {
		for (const cs of char.classSpells) for (const sp of cs.spells ?? []) allSpells.push(sp);
	}
	const spellAttackBonus = Math.floor((stats.int - 10) / 2) + pb;
	for (const spell of allSpells) {
		const def = spell.definition;
		if (!def || (def.level ?? 0) !== 0) continue;
		const actType = def.activation?.activationType;
		if (actType !== 1 && actType !== 3) continue; // action or bonus action only
		const rangeVal = def.range?.rangeValue;
		actions.push({
			name: def.name ?? "Cantrip",
			attackBonus: spellAttackBonus,
			damageDice: null,
			damageBonus: 0,
			range: rangeVal ? `${rangeVal} ft` : (def.range?.origin ?? "—"),
			notes: def.school ?? "",
			isSpell: true,
		});
	}

	return actions;
}

// ─── Plugin class ─────────────────────────────────────────────────────────────

export default class DnDBeyondImporterPlugin extends Plugin {
	settings!: DnDBeyondImporterSettings;
	rollHistory: DiceRoll[] = [];
	/** HP tracking state persisted across sessions. Maps character ID or note path to HP. */
	hpTracking: Map<string, {maxHp: number; currentHp: number; tempHp: number}> = new Map();
	/** Legacy single-char cache (used by "Open Character Roll Sheet" command fallback). */
	lastImportedChar: { char: DdbCharacter; stats: Record<string, number>; pb: number } | null = null;
	/** Per-character cache keyed by DnD Beyond character ID (string). */
	charCache: Map<string, { char: DdbCharacter; stats: Record<string, number>; pb: number }> = new Map();

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

		this.addCommand({
			id: "open-roll-sheet",
			name: "Open Character Roll Sheet",
			callback: () => {
				if (!this.lastImportedChar) {
					new Notice("Import a character first to use the Roll Sheet.", 3000);
					return;
				}
				const { char, stats, pb } = this.lastImportedChar;
				new CharacterSheetModal(this.app, this, char, stats, pb).open();
			},
		});

		// Ribbon icon — open roll sheet for the note that is currently active
		this.addRibbonIcon("dices", "Open Roll Sheet for Active Character", () => {
			void this.openRollSheetForActiveNote();
		});

		this.addCommand({
			id: "open-roll-sheet-active-note",
			name: "Open Roll Sheet for active character note",
			callback: () => { void this.openRollSheetForActiveNote(); },
		});

		this.addCommand({
			id: "open-hp-tracker",
			name: "Open HP Tracker",
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				const characterId = activeFile?.basename ?? "default";
				new HPTrackerModal(this.app, this, characterId).open();
			},
		});

		this.addSettingTab(new DnDBeyondSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as DnDBeyondImporterSettings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Reads the `dndbeyond_id` front-matter field from the currently active note
	 * and opens the roll sheet for that character. If the character data is already
	 * in the session cache it is used immediately; otherwise it is fetched from the
	 * D&D Beyond API first.
	 */
	async openRollSheetForActiveNote(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice("No note is currently open.", 3000);
			return;
		}

		// Read front matter via Obsidian's metadataCache
		const meta = this.app.metadataCache.getFileCache(activeFile);
		const charId: string | number | undefined = meta?.frontmatter?.["dndbeyond_id"];

		if (!charId) {
			new Notice("This note doesn't have a dndbeyond_id front-matter field. Open a character note first, or import a character.", 4000);
			return;
		}

		const idStr = String(charId);

		// Use cached data when available
		const cached = this.charCache.get(idStr);
		if (cached) {
			new CharacterSheetModal(this.app, this, cached.char, cached.stats, cached.pb).open();
			return;
		}

		// Not cached — fetch from the API
		new Notice(`⏳ Loading character ${idStr}…`);
		let data: DdbApiResponse;
		try {
			const apiUrl = `https://character-service.dndbeyond.com/character/v5/character/${idStr}`;
			const resp = await requestUrl({ url: apiUrl, headers: { Accept: "application/json" } });
			if (resp.status < 200 || resp.status >= 300) throw new Error(`HTTP ${resp.status}`);
			data = resp.json as DdbApiResponse;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ Failed to fetch character: ${msg}`);
			return;
		}

		if (!data.data) {
			new Notice("❌ No character data returned by the API.");
			return;
		}

		const char = data.data;
		const charClasses: DdbClass[] = char.classes ?? [];
		const charLevel = calcLevel(charClasses);
		const charPb = profBonus(charLevel);
		const charStats = {
			str: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 1),
			dex: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 2),
			con: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 3),
			int: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 4),
			wis: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 5),
			cha: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 6),
		};
		const entry = { char, stats: charStats, pb: charPb };
		this.charCache.set(idStr, entry);
		this.lastImportedChar = entry;
		new CharacterSheetModal(this.app, this, char, charStats, charPb).open();
	}

	async importCharacter(url: string): Promise<void> {
		const charId = extractCharacterId(url);
		if (!charId) {
			new Notice("❌ Could not extract a character ID from that URL.");
			return;
		}

		new Notice(`⏳ Fetching character ${charId}…`);

		let data: DdbApiResponse;
		try {
			const apiUrl = `https://character-service.dndbeyond.com/character/v5/character/${charId}`;
			const resp = await requestUrl({
				url: apiUrl,
				headers: { Accept: "application/json" },
			});
			if (resp.status < 200 || resp.status >= 300)
				throw new Error(`HTTP ${resp.status}`);
			data = resp.json as DdbApiResponse;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ Failed to fetch character: ${msg}`);
			console.error("[DnD Beyond Importer]", e);
			return;
		}

		let markdown: string;
		try {
			markdown = buildMarkdown(data, this.settings);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ Failed to parse character data: ${msg}`);
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

		// Store character data and open roll sheet
		if (data.data) {
			const char = data.data;
			const charClasses: DdbClass[] = char.classes ?? [];
			const charLevel = calcLevel(charClasses);
			const charPb = profBonus(charLevel);
			const charStats = {
				str: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 1),
				dex: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 2),
				con: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 3),
				int: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 4),
				wis: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 5),
				cha: getStatValue(char.stats ?? [], char.overrideStats ?? [], char.bonusStats ?? [], 6),
			};
			const entry = { char, stats: charStats, pb: charPb };
			this.lastImportedChar = entry;
			this.charCache.set(String(char.id), entry);
			new CharacterSheetModal(this.app, this, char, charStats, charPb).open();
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (file instanceof TFile) {
			// getLeaf(true) requires Obsidian ≥ 0.16.0 — minAppVersion set to 1.4.0 in manifest.json
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
			if (e.key === "Enter") void this.submit();
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
		importBtn.addEventListener("click", () => void this.submit());

		// Use window.setTimeout for popout window compatibility
		window.setTimeout(() => input.focus(), 50);
	}

	private async submit() {
		this.close();
		await this.plugin.importCharacter(this.urlValue.trim());
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── Character Sheet Roll Modal ──────────────────────────────────────────────

class CharacterSheetModal extends Modal {
	plugin: DnDBeyondImporterPlugin;
	char: DdbCharacter;
	stats: Record<string, number>;
	pb: number;

	constructor(app: App, plugin: DnDBeyondImporterPlugin, char: DdbCharacter, stats: Record<string, number>, pb: number) {
		super(app);
		this.plugin = plugin;
		this.char = char;
		this.stats = stats;
		this.pb = pb;
	}

	private roll20(modifier: number, label: string): void {
		const result = Math.floor(Math.random() * 20) + 1;
		const total = result + modifier;
		const modStr = modifier >= 0 ? `+${modifier}` : `${modifier}`;
		const now = new Date().toLocaleString();
		this.plugin.rollHistory.unshift({ die: "d20", result, modifier, label, timestamp: now });
		if (this.plugin.rollHistory.length > 50) this.plugin.rollHistory.length = 50;
		new Notice(`🎲 ${label}: d20(${result})${modStr} = **${total >= 0 ? total : total}**`, 5000);
		this.renderHistory();
	}

	private rollDamage(damageDice: string | null, damageBonus: number, label: string): void {
		let diceResult = 0;
		let diceLabel = "";
		if (damageDice) {
			const m = damageDice.match(/(\d+)d(\d+)/i);
			if (m) {
				const count = parseInt(m[1]);
				const sides = parseInt(m[2]);
				for (let i = 0; i < count; i++) diceResult += Math.floor(Math.random() * sides) + 1;
				diceLabel = damageDice;
			}
		} else {
			diceResult = damageBonus;
			diceLabel = `${damageBonus}`;
		}
		const total = diceResult + (damageDice ? damageBonus : 0);
		const bonusStr = damageBonus >= 0 ? `+${damageBonus}` : `${damageBonus}`;
		const now = new Date().toLocaleString();
		this.plugin.rollHistory.unshift({ die: diceLabel, result: diceResult, modifier: damageDice ? damageBonus : 0, label: `${label} DMG`, timestamp: now });
		if (this.plugin.rollHistory.length > 50) this.plugin.rollHistory.length = 50;
		new Notice(`⚔️ ${label} DMG: ${diceLabel}(${diceResult})${damageDice ? bonusStr : ""} = **${total}**`, 5000);
		this.renderHistory();
	}

	private historyEl!: HTMLElement;

	private renderHistory(): void {
		if (!this.historyEl) return;
		this.historyEl.empty();
		if (this.plugin.rollHistory.length === 0) {
			const empty = this.historyEl.createEl("div", { text: "No rolls yet." });
			Object.assign(empty.style, { color: "var(--text-muted)", fontSize: "13px", padding: "4px 0" });
			return;
		}
		for (const entry of this.plugin.rollHistory) {
			const row = this.historyEl.createEl("div");
			Object.assign(row.style, {
				display: "flex", justifyContent: "space-between",
				padding: "3px 0", borderBottom: "1px solid var(--background-modifier-border)", fontSize: "13px",
			});
			const modStr = entry.modifier >= 0 ? `+${entry.modifier}` : `${entry.modifier}`;
			const total = entry.result + entry.modifier;
			row.createEl("span", { text: `🎲 ${entry.label}: ${entry.die}(${entry.result})${modStr} = ${total}` });
			const ts = row.createEl("span", { text: entry.timestamp });
			Object.assign(ts.style, { color: "var(--text-muted)" });
		}
	}

	private makeRollBtn(container: HTMLElement, label: string, modifier: number, btnText?: string): void {
		const modStr = modifier >= 0 ? `+${modifier}` : `${modifier}`;
		const btn = container.createEl("button", { text: btnText ?? `🎲 ${modStr}` });
		Object.assign(btn.style, { fontSize: "11px", padding: "2px 6px", marginLeft: "6px", cursor: "pointer" });
		btn.addEventListener("click", () => this.roll20(modifier, label));
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		Object.assign(contentEl.style, { maxHeight: "80vh", overflowY: "auto", padding: "0 4px" });

		contentEl.createEl("h2", { text: `🎲 ${this.char.name ?? "Character"} — Roll Sheet` });

		const { stats, pb, char } = this;

		// ── Initiative ──────────────────────────────────────────────────────────
		const dexMod = Math.floor((stats.dex - 10) / 2);
		const initRow = contentEl.createEl("div");
		Object.assign(initRow.style, { display: "flex", alignItems: "center", marginBottom: "8px" });
		initRow.createEl("strong", { text: `Initiative: ${dexMod >= 0 ? "+" : ""}${dexMod}` });
		this.makeRollBtn(initRow, "Initiative", dexMod);

		contentEl.createEl("hr");

		// ── Ability Checks ───────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Ability Checks" });
		const abilityDefs = [
			{ label: "STR", key: "str" }, { label: "DEX", key: "dex" }, { label: "CON", key: "con" },
			{ label: "INT", key: "int" }, { label: "WIS", key: "wis" }, { label: "CHA", key: "cha" },
		];
		const abilityGrid = contentEl.createEl("div");
		Object.assign(abilityGrid.style, { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px", marginBottom: "12px" });
		for (const { label, key } of abilityDefs) {
			const mod = Math.floor((stats[key] - 10) / 2);
			const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
			const cell = abilityGrid.createEl("div");
			Object.assign(cell.style, { display: "flex", alignItems: "center", background: "var(--background-secondary)", borderRadius: "4px", padding: "4px 8px" });
			cell.createEl("span", { text: `${label} ${modStr}` });
			this.makeRollBtn(cell, `${label} Check`, mod);
		}

		contentEl.createEl("hr");

		// ── Saving Throws ───────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Saving Throws" });
		const saveKeys = [
			{ label: "STR Save", key: "str", subType: "strength-saving-throws" },
			{ label: "DEX Save", key: "dex", subType: "dexterity-saving-throws" },
			{ label: "CON Save", key: "con", subType: "constitution-saving-throws" },
			{ label: "INT Save", key: "int", subType: "intelligence-saving-throws" },
			{ label: "WIS Save", key: "wis", subType: "wisdom-saving-throws" },
			{ label: "CHA Save", key: "cha", subType: "charisma-saving-throws" },
		];
		const allMods: DdbModifier[] = [
			...(char.modifiers?.class ?? []), ...(char.modifiers?.race ?? []),
			...(char.modifiers?.background ?? []), ...(char.modifiers?.feat ?? []),
		];
		const saveGrid = contentEl.createEl("div");
		Object.assign(saveGrid.style, { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px", marginBottom: "12px" });
		for (const { label, key, subType } of saveKeys) {
			const base = Math.floor((stats[key] - 10) / 2);
			const prof = allMods.some(m => m.type === "proficiency" && m.subType === subType);
			const mod = prof ? base + pb : base;
			const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
			const cell = saveGrid.createEl("div");
			Object.assign(cell.style, { display: "flex", alignItems: "center", background: "var(--background-secondary)", borderRadius: "4px", padding: "4px 8px" });
			cell.createEl("span", { text: `${label} ${modStr}${prof ? " ✓" : ""}` });
			this.makeRollBtn(cell, label, mod);
		}

		contentEl.createEl("hr");

		// ── Skills ──────────────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Skills" });
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
		const skillGrid = contentEl.createEl("div");
		Object.assign(skillGrid.style, { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "4px", marginBottom: "12px" });
		for (const skill of skillDefs) {
			const base = Math.floor((stats[skill.stat] - 10) / 2);
			const expertise = allMods.some(m => m.type === "expertise" && m.subType === skill.key);
			const prof = allMods.some(m => m.type === "proficiency" && m.subType === skill.key);
			let mod = base;
			if (expertise) mod += pb * 2;
			else if (prof) mod += pb;
			const modStr = mod >= 0 ? `+${mod}` : `${mod}`;
			const marker = expertise ? " ★" : prof ? " ✓" : "";
			const cell = skillGrid.createEl("div");
			Object.assign(cell.style, { display: "flex", alignItems: "center", background: "var(--background-secondary)", borderRadius: "4px", padding: "3px 6px" });
			cell.createEl("span", { text: `${skill.name}${marker} ${modStr}`, cls: "" });
			Object.assign(cell.querySelector("span")!.style ?? {}, { flex: "1", fontSize: "12px" });
			this.makeRollBtn(cell, skill.name, mod);
		}

		contentEl.createEl("hr");

		// ── Actions ─────────────────────────────────────────────────────────────
		const actions = extractActions(char, stats, pb);
		if (actions.length) {
			contentEl.createEl("h3", { text: "Actions" });
			for (const action of actions) {
				const row = contentEl.createEl("div");
				Object.assign(row.style, {
					display: "flex", alignItems: "center", flexWrap: "wrap",
					background: "var(--background-secondary)", borderRadius: "4px",
					padding: "5px 8px", marginBottom: "5px", gap: "6px",
				});
				const nameEl = row.createEl("span");
				const atkStr = action.attackBonus != null
					? (action.attackBonus >= 0 ? `+${action.attackBonus}` : `${action.attackBonus}`)
					: "—";
				const dmgStr = action.damageDice
					? `${action.damageDice}${action.damageBonus !== 0 ? (action.damageBonus >= 0 ? `+${action.damageBonus}` : `${action.damageBonus}`) : ""}`
					: (action.damageBonus !== 0 ? `${action.damageBonus}` : "—");
				nameEl.setText(`${action.isSpell ? "✨ " : "⚔️ "}${action.name}  ATK ${atkStr}  DMG ${dmgStr}  (${action.range})`);
				Object.assign(nameEl.style, { flex: "1", fontSize: "13px" });

				if (action.attackBonus != null) {
					const atkBtn = row.createEl("button", { text: "🎲 ATK", cls: "mod-cta" });
					Object.assign(atkBtn.style, { fontSize: "11px", padding: "2px 7px" });
					atkBtn.addEventListener("click", () => this.roll20(action.attackBonus!, `${action.name} Attack`));
				}

				// Only show DMG button if there is actual damage to roll
				const hasDmg = action.damageDice != null || action.damageBonus !== 0;
				if (hasDmg) {
					const dmgBtn = row.createEl("button", { text: "🎲 DMG" });
					Object.assign(dmgBtn.style, { fontSize: "11px", padding: "2px 7px" });
					dmgBtn.addEventListener("click", () => this.rollDamage(action.damageDice, action.damageBonus, action.name));
				}
			}
		}

		contentEl.createEl("hr");

		// ── Roll History ─────────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Roll History" });
		this.historyEl = contentEl.createEl("div");
		Object.assign(this.historyEl.style, {
			maxHeight: "180px", overflowY: "auto",
			border: "1px solid var(--background-modifier-border)",
			borderRadius: "6px", padding: "6px 8px",
		});
		const clearBtn = contentEl.createEl("button", { text: "Clear History" });
		Object.assign(clearBtn.style, { marginTop: "8px", fontSize: "12px" });
		clearBtn.addEventListener("click", () => {
			this.plugin.rollHistory = [];
			this.renderHistory();
		});
		this.renderHistory();
	}

	onClose() { this.contentEl.empty(); }
}

// ─── HP Tracker Modal ─────────────────────────────────────────────────────────

class HPTrackerModal extends Modal {
	plugin: DnDBeyondImporterPlugin;
	characterId: string;

	constructor(app: App, plugin: DnDBeyondImporterPlugin, characterId: string) {
		super(app);
		this.plugin = plugin;
		this.characterId = characterId;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "❤️ HP Tracker" });

		// Get or create HP tracker for this character
		let tracker = this.plugin.hpTracking.get(this.characterId);
		if (!tracker) {
			tracker = { maxHp: 30, currentHp: 30, tempHp: 0 };
			this.plugin.hpTracking.set(this.characterId, tracker);
		}

		// ── HP Display ───────────────────────────────────────────────────────
		const displayEl = contentEl.createEl("div");
		Object.assign(displayEl.style, {
			background: "var(--background-secondary)",
			borderRadius: "8px",
			padding: "16px",
			marginBottom: "16px",
			textAlign: "center",
		});

		const hpBarEl = displayEl.createEl("div");
		Object.assign(hpBarEl.style, {
			display: "flex",
			height: "40px",
			borderRadius: "6px",
			overflow: "hidden",
			marginBottom: "8px",
			background: "var(--background-modifier-border)",
		});

		const hpPercent = (tracker.currentHp / tracker.maxHp) * 100;
		const hpColor = hpPercent > 50 ? "#4ade80" : hpPercent > 25 ? "#eab308" : "#ef4444";

		const hpFillEl = hpBarEl.createEl("div");
		Object.assign(hpFillEl.style, {
			width: `${Math.max(0, hpPercent)}%`,
			background: hpColor,
			transition: "width 0.2s ease",
		});

		const hpTextEl = displayEl.createEl("div");
		Object.assign(hpTextEl.style, {
			fontSize: "18px",
			fontWeight: "bold",
			marginBottom: "8px",
		});

		const tempEl = displayEl.createEl("div");
		Object.assign(tempEl.style, { fontSize: "13px", color: "var(--text-muted)" });

		const updateDisplay = () => {
			const total = tracker!.currentHp + tracker!.tempHp;
			hpTextEl.setText(`${total}/${tracker!.maxHp} HP`);
			if (tracker!.tempHp > 0) {
				tempEl.setText(`Temp: ${tracker!.tempHp}`);
			} else {
				tempEl.setText("");
			}

			const newPercent = (tracker!.currentHp / tracker!.maxHp) * 100;
			const newColor = newPercent > 50 ? "#4ade80" : newPercent > 25 ? "#eab308" : "#ef4444";
			hpFillEl.style.width = `${Math.max(0, newPercent)}%`;
			hpFillEl.style.background = newColor;
		};

		// ── Current HP Controls ──────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Current HP" });

		const currentCtrlEl = contentEl.createEl("div");
		Object.assign(currentCtrlEl.style, {
			display: "flex",
			gap: "8px",
			marginBottom: "16px",
			alignItems: "center",
		});

		const currentInputEl = currentCtrlEl.createEl("input");
		Object.assign(currentInputEl, {
			type: "number",
			value: String(tracker.currentHp),
			min: "0",
			max: String(tracker.maxHp),
		});
		Object.assign(currentInputEl.style, { flex: "1", padding: "6px", fontSize: "14px" });
		currentInputEl.addEventListener("change", () => {
			tracker!.currentHp = Math.max(0, Math.min(tracker!.maxHp, Number(currentInputEl.value)));
			updateDisplay();
		});

		const minusBtn = currentCtrlEl.createEl("button", { text: "−5" });
		Object.assign(minusBtn.style, { padding: "6px 12px", fontSize: "14px" });
		minusBtn.addEventListener("click", () => {
			tracker!.currentHp = Math.max(0, tracker!.currentHp - 5);
			currentInputEl.value = String(tracker!.currentHp);
			updateDisplay();
		});

		const minusOneBtn = currentCtrlEl.createEl("button", { text: "−1" });
		Object.assign(minusOneBtn.style, { padding: "6px 12px", fontSize: "14px" });
		minusOneBtn.addEventListener("click", () => {
			tracker!.currentHp = Math.max(0, tracker!.currentHp - 1);
			currentInputEl.value = String(tracker!.currentHp);
			updateDisplay();
		});

		const plusOneBtn = currentCtrlEl.createEl("button", { text: "+1" });
		Object.assign(plusOneBtn.style, { padding: "6px 12px", fontSize: "14px" });
		plusOneBtn.addEventListener("click", () => {
			tracker!.currentHp = Math.min(tracker!.maxHp, tracker!.currentHp + 1);
			currentInputEl.value = String(tracker!.currentHp);
			updateDisplay();
		});

		const plusFiveBtn = currentCtrlEl.createEl("button", { text: "+5" });
		Object.assign(plusFiveBtn.style, { padding: "6px 12px", fontSize: "14px" });
		plusFiveBtn.addEventListener("click", () => {
			tracker!.currentHp = Math.min(tracker!.maxHp, tracker!.currentHp + 5);
			currentInputEl.value = String(tracker!.currentHp);
			updateDisplay();
		});

		// ── Temporary HP Controls ────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Temporary HP" });

		const tempCtrlEl = contentEl.createEl("div");
		Object.assign(tempCtrlEl.style, {
			display: "flex",
			gap: "8px",
			marginBottom: "16px",
			alignItems: "center",
		});

		const tempInputEl = tempCtrlEl.createEl("input");
		Object.assign(tempInputEl, {
			type: "number",
			value: String(tracker.tempHp),
			min: "0",
		});
		Object.assign(tempInputEl.style, { flex: "1", padding: "6px", fontSize: "14px" });
		tempInputEl.addEventListener("change", () => {
			tracker!.tempHp = Math.max(0, Number(tempInputEl.value));
			updateDisplay();
		});

		const tempClearBtn = tempCtrlEl.createEl("button", { text: "Clear" });
		Object.assign(tempClearBtn.style, { padding: "6px 12px", fontSize: "14px" });
		tempClearBtn.addEventListener("click", () => {
			tracker!.tempHp = 0;
			tempInputEl.value = "0";
			updateDisplay();
		});

		// ── Max HP Setup ─────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Max HP" });

		const maxCtrlEl = contentEl.createEl("div");
		Object.assign(maxCtrlEl.style, {
			display: "flex",
			gap: "8px",
			marginBottom: "16px",
			alignItems: "center",
		});

		const maxInputEl = maxCtrlEl.createEl("input");
		Object.assign(maxInputEl, {
			type: "number",
			value: String(tracker.maxHp),
			min: "1",
		});
		Object.assign(maxInputEl.style, { flex: "1", padding: "6px", fontSize: "14px" });
		maxInputEl.addEventListener("change", () => {
			tracker!.maxHp = Math.max(1, Number(maxInputEl.value));
			// Cap current HP to new max
			tracker!.currentHp = Math.min(tracker!.currentHp, tracker!.maxHp);
			currentInputEl.value = String(tracker!.currentHp);
			updateDisplay();
		});

		// Initial display
		updateDisplay();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── Dice Roller Modal ────────────────────────────────────────────────────────

class DiceRollerModal extends Modal {
	plugin: DnDBeyondImporterPlugin;
	filterDie: string | null = null; // null = show all

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
					modifier: 0,
					label: die.label,
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
				this.renderHistory();
			});
		}

		// ── History ──────────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Roll History" });

		// ── History controls (filter, export, stats) ────────────────────────
		const controlsEl = contentEl.createEl("div");
		Object.assign(controlsEl.style, {
			display: "flex",
			gap: "6px",
			marginBottom: "8px",
			flexWrap: "wrap",
		});

		const filterLabel = controlsEl.createEl("label");
		Object.assign(filterLabel.style, { fontSize: "12px", display: "flex", alignItems: "center", gap: "4px" });
		filterLabel.setText("Filter:");
		const filterSelect = filterLabel.createEl("select");
		filterSelect.add(new Option("All dice", ""));
		for (const die of dice) {
			filterSelect.add(new Option(die.label, die.label));
		}
		filterSelect.addEventListener("change", (e) => {
			this.filterDie = (e.target as HTMLSelectElement).value || null;
			this.renderHistory();
		});
		Object.assign(filterSelect.style, { fontSize: "12px", padding: "2px 4px" });

		const exportBtn = controlsEl.createEl("button", { text: "Export CSV" });
		Object.assign(exportBtn.style, { fontSize: "11px", padding: "3px 8px" });
		exportBtn.addEventListener("click", () => this.exportHistoryCSV());

		const copyBtn = controlsEl.createEl("button", { text: "Copy History" });
		Object.assign(copyBtn.style, { fontSize: "11px", padding: "3px 8px" });
		copyBtn.addEventListener("click", () => this.copyHistoryToClipboard());

		// ── History display ─────────────────────────────────────────────────
		const historyEl = contentEl.createEl("div");
		Object.assign(historyEl.style, {
			maxHeight: "200px",
			overflowY: "auto",
			border: "1px solid var(--background-modifier-border)",
			borderRadius: "6px",
			padding: "6px 8px",
		});
		(this as any).historyEl = historyEl; // Store for renderHistory

		// ── Statistics section ───────────────────────────────────────────────
		const statsEl = contentEl.createEl("div");
		Object.assign(statsEl.style, {
			marginTop: "12px",
			fontSize: "12px",
			color: "var(--text-muted)",
			padding: "8px",
			background: "var(--background-secondary)",
			borderRadius: "4px",
		});
		(this as any).statsEl = statsEl; // Store for renderHistory

		const clearBtn = contentEl.createEl("button", { text: "Clear History" });
		Object.assign(clearBtn.style, {
			marginTop: "8px",
			fontSize: "12px",
		});
		clearBtn.addEventListener("click", () => {
			this.plugin.rollHistory = [];
			this.renderHistory();
		});

		this.renderHistory();
	}

	getFilteredHistory(): DiceRoll[] {
		if (!this.filterDie) return this.plugin.rollHistory;
		return this.plugin.rollHistory.filter((r) => r.die === this.filterDie);
	}

	renderHistory() {
		const historyEl = (this as any).historyEl;
		const statsEl = (this as any).statsEl;
		const filtered = this.getFilteredHistory();

		historyEl.empty();
		if (filtered.length === 0) {
			const empty = historyEl.createEl("div", { text: "No rolls yet." });
			Object.assign(empty.style, {
				color: "var(--text-muted)",
				fontSize: "13px",
				padding: "4px 0",
			});
		} else {
			for (const entry of filtered) {
				const row = historyEl.createEl("div");
				Object.assign(row.style, {
					display: "flex",
					justifyContent: "space-between",
					padding: "3px 0",
					borderBottom: "1px solid var(--background-modifier-border)",
					fontSize: "13px",
				});
				const entryModStr = entry.modifier >= 0 ? `+${entry.modifier}` : `${entry.modifier}`;
				const entryTotal = entry.result + entry.modifier;
				row.createEl("span", {
					text: `🎲 ${entry.label}: ${entry.die}(${entry.result})${entry.modifier !== 0 ? entryModStr : ""} = ${entryTotal}`,
				});
				const ts = row.createEl("span", { text: entry.timestamp });
				Object.assign(ts.style, { color: "var(--text-muted)" });
			}
		}

		// ── Update statistics ───────────────────────────────────────────────
		this.updateStats(filtered, statsEl);
	}

	updateStats(filtered: DiceRoll[], statsEl: HTMLElement) {
		if (filtered.length === 0) {
			statsEl.setText("");
			return;
		}

		const results = filtered.map((r) => r.result);
		const avg = (results.reduce((a, b) => a + b, 0) / results.length).toFixed(2);
		const max = Math.max(...results);
		const min = Math.min(...results);
		const nat20s = results.filter((r) => r === 20).length;
		const nat1s = results.filter((r) => r === 1).length;

		// Mode (most common roll)
		const freq: Record<number, number> = {};
		results.forEach((r) => {
			freq[r] = (freq[r] ?? 0) + 1;
		});
		const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
		const modeStr = mode ? `${mode[0]} (${mode[1]}×)` : "—";

		let statsText = `Avg: ${avg} | Max: ${max} | Min: ${min} | Mode: ${modeStr}`;
		if (nat20s > 0) statsText += ` | 🎉 ${nat20s}×`;
		if (nat1s > 0) statsText += ` | 💀 ${nat1s}×`;

		statsEl.setText(statsText);
	}

	exportHistoryCSV() {
		const filtered = this.getFilteredHistory();
		if (filtered.length === 0) {
			new Notice("No rolls to export.", 2000);
			return;
		}

		let csv = "Die,Result,Modifier,Total,Timestamp\n";
		for (const entry of filtered) {
			const total = entry.result + entry.modifier;
			csv += `${entry.die},${entry.result},${entry.modifier},${total},"${entry.timestamp}"\n`;
		}

		const blob = new Blob([csv], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `roll-history-${new Date().toISOString().split("T")[0]}.csv`;
		a.click();
		URL.revokeObjectURL(url);
		new Notice("History exported as CSV.", 2000);
	}

	copyHistoryToClipboard() {
		const filtered = this.getFilteredHistory();
		if (filtered.length === 0) {
			new Notice("No rolls to copy.", 2000);
			return;
		}

		let text = "Roll History:\n";
		for (const entry of filtered) {
			const modStr = entry.modifier >= 0 ? `+${entry.modifier}` : `${entry.modifier}`;
			const total = entry.result + entry.modifier;
			text += `${entry.die}(${entry.result})${entry.modifier !== 0 ? modStr : ""} = ${total} [${entry.timestamp}]\n`;
		}

		navigator.clipboard.writeText(text).then(() => {
			new Notice("History copied to clipboard.", 2000);
		});
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

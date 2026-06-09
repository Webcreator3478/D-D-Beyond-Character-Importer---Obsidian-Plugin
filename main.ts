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
	// 5etools integration (disabled by default)
	fiveEtoolsEnabled: boolean;
	fiveEtoolsBaseUrl: string;
}

interface HPState {
	max: number;
	current: number;
	temp: number;
	dsS: number;
	dsF: number;
	log: string[];
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
	fiveEtoolsEnabled: false,
	fiveEtoolsBaseUrl: "https://5e.tools",
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

	// ── Interactive Sheet Button marker (post-processor picks this up) ────────
	md += `\`\`\`dnd-sheet-launcher\ncharId:${char.id}\n\`\`\`\n\n`;

	// ── HP Tracker Widget ───────────────────────────────────────────────────
	md += buildHPTrackerWidget(char.id, hp.max, hp.current, hp.temp);

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

// ─── HP Tracker Widget ────────────────────────────────────────────────────────
// Outputs a marker <div> only — the MarkdownPostProcessor in onload() wires it up.

function buildHPTrackerWidget(charId: number, maxHp: number, currentHp: number, tempHp: number): string {
	return `\`\`\`dnd-hp-tracker\ncharId:${charId}\nmaxHp:${maxHp}\ncurrentHp:${currentHp}\ntempHp:${tempHp}\n\`\`\`\n\n`;
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
	/** Per-character cache keyed by DnD Beyond character ID (string). */
	charCache: Map<string, { char: DdbCharacter; stats: Record<string, number>; pb: number }> = new Map();
	/** In-memory session state (replaces sessionStorage): HP widget state, spell slots, equipment, notes. */
	sessionState: Map<string, string> = new Map();

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

		// ── HP Tracker Code Block Processor ───────────────────────────────────
		// Handles ```dnd-hp-tracker blocks emitted by buildHPTrackerWidget()
		this.registerMarkdownCodeBlockProcessor("dnd-hp-tracker", (source, el) => {
			const params: Record<string, string> = {};
			for (const line of source.split("\n")) {
				const [k, v] = line.split(":"); if (k && v) params[k.trim()] = v.trim();
			}
			const charId  = params["charId"] ?? "0";
			const maxHp   = parseInt(params["maxHp"]     ?? "30", 10);
			const initCur = parseInt(params["currentHp"] ?? String(maxHp), 10);
			const initTmp = parseInt(params["tempHp"]    ?? "0",  10);
			const STORE_KEY = `dnd-hp-${charId}`;

			const loadState = (): HPState => {
				try {
					const raw = this.sessionState.get(STORE_KEY);
					if (raw) { const s = JSON.parse(raw) as HPState; s.max = maxHp; return s; }
				} catch { /* */ }
				return { max: maxHp, current: initCur, temp: initTmp, dsS: 0, dsF: 0, log: [] };
			};
			const saveState = (s: HPState) => this.sessionState.set(STORE_KEY, JSON.stringify(s));
			let state = loadState();

			const w = el.createEl("div");
			w.style.cssText = "font-family:var(--font-interface,sans-serif);background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:10px;padding:16px 20px;margin:4px 0 16px 0;max-width:500px;";

			const hdr = w.createEl("div"); hdr.setText("❤️ HP Tracker");
			hdr.style.cssText = "font-size:13px;font-weight:700;letter-spacing:.05em;color:var(--text-muted);text-transform:uppercase;margin-bottom:10px;";

			const barWrap = w.createEl("div"); barWrap.style.cssText = "position:relative;height:28px;border-radius:6px;overflow:hidden;background:var(--background-modifier-border);margin-bottom:8px;";
			const barFill = barWrap.createEl("div"); barFill.style.cssText = "height:100%;width:100%;border-radius:6px;transition:width .25s ease,background .25s ease;";
			const barLbl  = barWrap.createEl("div"); barLbl.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5);pointer-events:none;";

			const tempBadge = w.createEl("div"); tempBadge.style.cssText = "font-size:12px;color:var(--text-muted);text-align:right;margin-bottom:10px;min-height:16px;";

			const dsSuccessPips: HTMLButtonElement[] = [];
			const dsFailurePips: HTMLButtonElement[] = [];

			const render = () => {
				const pct = Math.max(0, Math.min(100, (state.current / state.max) * 100));
				barFill.style.width = pct + "%";
				barFill.style.background = pct > 50 ? "#4ade80" : pct > 25 ? "#eab308" : "#ef4444";
				barLbl.textContent = `${state.current} / ${state.max} HP`;
				tempBadge.textContent = state.temp > 0 ? `💙 +${state.temp} temp HP` : "";
				dsSuccessPips.forEach((p, i) => { p.style.background = i < state.dsS ? "#4ade80" : "transparent"; });
				dsFailurePips.forEach((p, i) => { p.style.background = i < state.dsF ? "#ef4444" : "transparent"; });
				logEl.empty();
				(state.log ?? []).slice(0, 20).forEach((entry) => {
					const row = logEl.createEl("div"); row.style.cssText = "padding:2px 0;border-bottom:1px solid var(--background-modifier-border);";
					row.setText(entry);
				});
				saveState(state);
			};

			const addLog = (msg: string) => {
				const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				state.log = state.log ?? []; state.log.unshift(`[${t}] ${msg}`);
				if (state.log.length > 20) state.log.length = 20;
			};

			// Damage / Heal row
			const dmgRow = w.createEl("div"); dmgRow.style.cssText = "display:flex;gap:6px;margin-bottom:8px;align-items:center;";
			const amtInput = dmgRow.createEl("input") as HTMLInputElement;
			amtInput.type = "number"; amtInput.min = "0"; amtInput.value = "1";
			amtInput.style.cssText = "width:60px;padding:5px 6px;font-size:14px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);text-align:center;";
			const getAmt = () => Math.max(0, parseInt(amtInput.value, 10) || 0);

			const dmgBtn = dmgRow.createEl("button"); dmgBtn.setText("⚔️ Damage");
			dmgBtn.style.cssText = "flex:1;padding:6px 0;border-radius:5px;border:none;background:#ef4444;color:#fff;font-weight:700;font-size:13px;cursor:pointer;";
			dmgBtn.addEventListener("click", () => {
				const n = getAmt(); const ft = Math.min(state.temp, n);
				state.temp -= ft; state.current = Math.max(0, state.current - (n - ft));
				addLog(`⚔️ −${n} dmg → ${state.current} HP`); render();
			});

			const healBtn = dmgRow.createEl("button"); healBtn.setText("💚 Heal");
			healBtn.style.cssText = "flex:1;padding:6px 0;border-radius:5px;border:none;background:#4ade80;color:#1a1a1a;font-weight:700;font-size:13px;cursor:pointer;";
			healBtn.addEventListener("click", () => {
				const n = getAmt(); state.current = Math.min(state.max, state.current + n);
				addLog(`💚 +${n} heal → ${state.current} HP`); render();
			});

			// Quick buttons
			const quickRow = w.createEl("div"); quickRow.style.cssText = "display:flex;gap:4px;margin-bottom:12px;";
			const qBtn = (lbl: string, d: number) => {
				const b = quickRow.createEl("button"); b.setText(lbl);
				b.style.cssText = "flex:1;padding:4px 0;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);font-size:12px;cursor:pointer;";
				b.addEventListener("click", () => {
					if (d < 0) { const ft = Math.min(state.temp,-d); state.temp-=ft; state.current=Math.max(0,state.current-(-d-ft)); addLog(`⚔️ ${d} → ${state.current} HP`); }
					else if (d === 0) { state.current=state.max; addLog(`✨ Full rest → ${state.max} HP`); }
					else { state.current=Math.min(state.max,state.current+d); addLog(`💚 +${d} → ${state.current} HP`); }
					render();
				});
			};
			qBtn("−10",-10); qBtn("−5",-5); qBtn("−1",-1); qBtn("Full",0); qBtn("+1",1); qBtn("+5",5); qBtn("+10",10);

			// Temp HP
			const tmpRow = w.createEl("div"); tmpRow.style.cssText = "display:flex;gap:6px;margin-bottom:12px;align-items:center;";
			const tmpLbl = tmpRow.createEl("span"); tmpLbl.setText("Temp HP:"); tmpLbl.style.cssText = "font-size:12px;color:var(--text-muted);white-space:nowrap;";
			const tmpInput = tmpRow.createEl("input") as HTMLInputElement;
			tmpInput.type = "number"; tmpInput.min = "0"; tmpInput.value = String(state.temp);
			tmpInput.style.cssText = "width:60px;padding:5px 6px;font-size:13px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);text-align:center;";
			const setTmpBtn = tmpRow.createEl("button"); setTmpBtn.setText("Set");
			setTmpBtn.style.cssText = "padding:5px 10px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);font-size:12px;cursor:pointer;";
			setTmpBtn.addEventListener("click", () => { state.temp=Math.max(0,parseInt(tmpInput.value,10)||0); addLog(`💙 Temp HP set to ${state.temp}`); render(); });
			const clrTmpBtn = tmpRow.createEl("button"); clrTmpBtn.setText("Clear");
			clrTmpBtn.style.cssText = "padding:5px 10px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:12px;cursor:pointer;";
			clrTmpBtn.addEventListener("click", () => { state.temp=0; tmpInput.value="0"; addLog("💙 Temp HP cleared"); render(); });

			// Death Saves
			const dsSection = w.createEl("div"); dsSection.style.cssText = "border-top:1px solid var(--background-modifier-border);padding-top:10px;margin-bottom:10px;";
			const dsTitle = dsSection.createEl("div"); dsTitle.setText("Death Saves"); dsTitle.style.cssText = "font-size:12px;color:var(--text-muted);margin-bottom:6px;font-weight:600;";
			const dsRow = dsSection.createEl("div"); dsRow.style.cssText = "display:flex;gap:16px;align-items:center;";
			const makePips = (color: string, pips: HTMLButtonElement[], get: () => number, set: (n: number) => void) => {
				const grp = dsRow.createEl("div"); grp.style.cssText = "display:flex;align-items:center;gap:6px;";
				for (let i = 1; i <= 3; i++) {
					const p = grp.createEl("button") as HTMLButtonElement; const idx = i;
					p.style.cssText = `width:20px;height:20px;border-radius:50%;border:2px solid ${color};background:transparent;cursor:pointer;transition:background .15s;`;
					p.addEventListener("click", () => { set(get()>=idx ? idx-1 : idx); render(); });
					pips.push(p);
				}
			};
			makePips("#4ade80", dsSuccessPips, () => state.dsS, (n) => { state.dsS=n; });
			makePips("#ef4444", dsFailurePips, () => state.dsF, (n) => { state.dsF=n; });
			const dsReset = dsRow.createEl("button"); dsReset.setText("Reset");
			dsReset.style.cssText = "margin-left:auto;padding:3px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:11px;cursor:pointer;";
			dsReset.addEventListener("click", () => { state.dsS=0; state.dsF=0; addLog("🔄 Death saves reset"); render(); });

			// Change Log
			const logSection = w.createEl("div"); logSection.style.cssText = "border-top:1px solid var(--background-modifier-border);padding-top:10px;";
			const logHeader = logSection.createEl("div"); logHeader.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;";
			const logTitle = logHeader.createEl("span"); logTitle.setText("Change Log"); logTitle.style.cssText = "font-size:12px;color:var(--text-muted);font-weight:600;";
			const clrLog = logHeader.createEl("button"); clrLog.setText("Clear");
			clrLog.style.cssText = "padding:2px 7px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:11px;cursor:pointer;";
			clrLog.addEventListener("click", () => { state.log=[]; render(); });
			const logEl = logSection.createEl("div"); logEl.style.cssText = "max-height:110px;overflow-y:auto;font-size:12px;color:var(--text-muted);";

			render();
		});

		// ── Character Sheet Launcher Code Block Processor ───────────────────────
		// Handles ```dnd-sheet-launcher blocks emitted by buildMarkdown()
		this.registerMarkdownCodeBlockProcessor("dnd-sheet-launcher", (source, el) => {
			const params: Record<string, string> = {};
			for (const line of source.split("\n")) {
				const [k, v] = line.split(":"); if (k && v) params[k.trim()] = v.trim();
			}
			const charId = params["charId"] ?? "0";

			const row = el.createEl("div");
			row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px;";

			const sheetBtn = row.createEl("button");
			sheetBtn.style.cssText = "display:inline-flex;align-items:center;gap:8px;background:var(--interactive-accent);color:var(--text-on-accent);border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s;";
			sheetBtn.setText("⚔️ Open Interactive Character Sheet");
			sheetBtn.addEventListener("mouseenter", () => { sheetBtn.style.opacity = "0.85"; });
			sheetBtn.addEventListener("mouseleave", () => { sheetBtn.style.opacity = "1"; });
			sheetBtn.addEventListener("click", () => {
				const cached = this.charCache.get(charId);
				if (!cached) {
					new Notice("Import the character first so the sheet has data to display.", 3000);
					return;
				}
				new FullCharacterSheetModal(this.app, this, cached.char, cached.stats, cached.pb).open();
			});

			const refreshBtn = row.createEl("button");
			refreshBtn.style.cssText = "display:inline-flex;align-items:center;gap:6px;background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:opacity .15s;";
			refreshBtn.setText("🔄 Refresh from D&D Beyond");
			refreshBtn.addEventListener("mouseenter", () => { refreshBtn.style.opacity = "0.75"; });
			refreshBtn.addEventListener("mouseleave", () => { refreshBtn.style.opacity = "1"; });
			refreshBtn.addEventListener("click", async () => {
				refreshBtn.setText("⏳ Refreshing…");
				refreshBtn.setAttribute("disabled", "true");
				refreshBtn.style.cursor = "not-allowed";
				try {
					await this.importCharacter(charId);
				} finally {
					refreshBtn.removeAttribute("disabled");
					refreshBtn.style.cursor = "pointer";
					refreshBtn.setText("🔄 Refresh from D&D Beyond");
				}
			});
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()) as DnDBeyondImporterSettings;
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

		// Cache character data for the interactive sheet launcher
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
			this.charCache.set(String(char.id), entry);
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

		// Use document.execCommand for clipboard write — avoids browser clipboard API
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		try {
			document.execCommand("copy");
			new Notice("History copied to clipboard.", 2000);
		} catch {
			new Notice("Copy failed — please copy the text manually.", 3000);
		} finally {
			document.body.removeChild(ta);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ─── 5etools data fetcher ──────────────────────────────────────────────────────

async function fetch5eData(
	baseUrl: string,
	type: "spells" | "items" | "classfeature" | "races",
	name: string
): Promise<Record<string, unknown> | null> {
	const clean = baseUrl.replace(/\/$/, "");
	// 5etools data lives at /data/<type>.json — we search the array by name
	const urls: Record<string, string> = {
		spells:       `${clean}/data/spells/spells-phb.json`,
		items:        `${clean}/data/items.json`,
		classfeature: `${clean}/data/classfeature.json`,
		races:        `${clean}/data/races.json`,
	};
	try {
		const resp = await requestUrl({ url: urls[type], headers: { Accept: "application/json" } });
		if (resp.status < 200 || resp.status >= 300) return null;
		const json = resp.json as Record<string, unknown[]>;
		// Each file has a top-level array keyed by type name (spell, item, classFeature, race)
		const keyMap: Record<string, string> = { spells: "spell", items: "item", classfeature: "classFeature", races: "race" };
		const arr = json[keyMap[type]] as Array<Record<string, unknown>> | undefined;
		if (!arr) return null;
		const lower = name.toLowerCase();
		return arr.find((e) => (e["name"] as string)?.toLowerCase() === lower) ?? null;
	} catch {
		return null;
	}
}

function render5eDescription(entry: Record<string, unknown>): string {
	// 5etools stores descriptions as arrays of strings or objects
	const entries = entry["entries"] as Array<unknown> | undefined;
	if (!entries) return entry["desc"] as string ?? "";
	return entries.map((e) => {
		if (typeof e === "string") return e;
		const obj = e as Record<string, unknown>;
		if (obj["type"] === "entries") return `**${obj["name"] ?? ""}**\n${(obj["entries"] as string[])?.join("\n") ?? ""}`;
		if (obj["type"] === "list") return (obj["items"] as string[])?.map((i) => `• ${i}`).join("\n") ?? "";
		if (obj["type"] === "table") {
			const cols = obj["colLabels"] as string[] ?? [];
			const rows = obj["rows"] as string[][] ?? [];
			return `| ${cols.join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n` +
				rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
		}
		return JSON.stringify(e);
	}).join("\n\n");
}

// ─── Full Interactive Character Sheet Modal ────────────────────────────────────

class FullCharacterSheetModal extends Modal {
	plugin: DnDBeyondImporterPlugin;
	char: DdbCharacter;
	stats: Record<string, number>;
	pb: number;
	rollLog: Array<{ text: string; ts: string }> = [];

	constructor(app: App, plugin: DnDBeyondImporterPlugin, char: DdbCharacter, stats: Record<string, number>, pb: number) {
		super(app);
		this.plugin = plugin;
		this.char   = char;
		this.stats  = stats;
		this.pb     = pb;
		// Make modal wider
		this.modalEl.style.cssText += ";width:min(900px,95vw);max-height:92vh;overflow-y:auto;";
	}

	// ── Roll helpers ─────────────────────────────────────────────────────────

	private mod(score: number): number { return Math.floor((score - 10) / 2); }
	private modStr(n: number): string { return n >= 0 ? `+${n}` : `${n}`; }

	private rollD20(modifier: number, label: string): void {
		const raw = Math.floor(Math.random() * 20) + 1;
		const total = raw + modifier;
		const modStr = this.modStr(modifier);
		const text = `🎲 ${label}: d20(${raw})${modStr} = ${total}`;
		const isCrit = raw === 20;
		const isFumble = raw === 1;
		const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		this.rollLog.unshift({ text: (isCrit ? "🎉 " : isFumble ? "💀 " : "") + text, ts });
		if (this.rollLog.length > 30) this.rollLog.length = 30;
		this.refreshRollLog();
		new Notice(text, 4000);
		// Also push to plugin-wide history
		this.plugin.rollHistory.unshift({ die: "d20", result: raw, modifier, label, timestamp: new Date().toLocaleString() });
	}

	private rollDamage(dice: string | null, bonus: number, label: string): void {
		if (!dice) {
			new Notice(`${label}: no damage dice`, 2000);
			return;
		}
		const match = dice.match(/^(\d+)d(\d+)$/);
		if (!match) { new Notice(`${label}: ${dice}+${bonus}`, 2000); return; }
		let total = bonus;
		const rolls: number[] = [];
		const count = parseInt(match[1]);
		const sides = parseInt(match[2]);
		for (let i = 0; i < count; i++) {
			const r = Math.floor(Math.random() * sides) + 1;
			rolls.push(r);
			total += r;
		}
		const bonusStr = bonus !== 0 ? (bonus >= 0 ? `+${bonus}` : `${bonus}`) : "";
		const text = `🎲 ${label} DMG: [${rolls.join(",")}]${bonusStr} = ${total}`;
		const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		this.rollLog.unshift({ text, ts });
		if (this.rollLog.length > 30) this.rollLog.length = 30;
		this.refreshRollLog();
		new Notice(text, 4000);
	}

	private rollLogEl: HTMLElement | null = null;

	private refreshRollLog(): void {
		if (!this.rollLogEl) return;
		this.rollLogEl.empty();
		if (this.rollLog.length === 0) {
			this.rollLogEl.createEl("div", { text: "No rolls yet." }).style.cssText = "color:var(--text-muted);font-size:12px;padding:4px 0;";
			return;
		}
		for (const entry of this.rollLog) {
			const row = this.rollLogEl.createEl("div");
			row.style.cssText = "display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--background-modifier-border);font-size:12px;";
			row.createEl("span").setText(entry.text);
			const ts = row.createEl("span");
			ts.setText(entry.ts);
			ts.style.cssText = "color:var(--text-muted);margin-left:8px;white-space:nowrap;";
		}
	}

	// ── HP state ─────────────────────────────────────────────────────────────

	private loadHP(): HPState {
		const key = `dnd-hp-${this.char.id}`;
		try {
			const raw = this.plugin.sessionState.get(key);
			if (raw) {
				const s = JSON.parse(raw) as HPState;
				const hp = calcHP(this.char);
				s.max = hp.max;
				return s;
			}
		} catch { /* */ }
		const hp = calcHP(this.char);
		return { max: hp.max, current: hp.current, temp: hp.temp, dsS: 0, dsF: 0, log: [] };
	}

	private saveHP(s: HPState): void {
		this.plugin.sessionState.set(`dnd-hp-${this.char.id}`, JSON.stringify(s));
	}

	// ── Section builders ─────────────────────────────────────────────────────

	private sectionEl(parent: HTMLElement, title: string): HTMLElement {
		const wrap = parent.createEl("div");
		wrap.style.cssText = "margin-bottom:24px;";
		const hdr = wrap.createEl("div");
		hdr.style.cssText = "font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);border-bottom:1px solid var(--background-modifier-border);padding-bottom:4px;margin-bottom:12px;";
		hdr.setText(title);
		return wrap;
	}

	private pill(parent: HTMLElement, label: string, value: string, sub?: string): void {
		const p = parent.createEl("div");
		p.style.cssText = "display:flex;flex-direction:column;align-items:center;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px 14px;min-width:70px;";
		const lbl = p.createEl("div");
		lbl.setText(label);
		lbl.style.cssText = "font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.08em;";
		const val = p.createEl("div");
		val.setText(value);
		val.style.cssText = "font-size:22px;font-weight:900;color:var(--text-normal);line-height:1.1;";
		if (sub) {
			const s = p.createEl("div");
			s.setText(sub);
			s.style.cssText = "font-size:11px;color:var(--text-muted);margin-top:2px;";
		}
	}

	private rollBtn(parent: HTMLElement, label: string, modifier: number): HTMLButtonElement {
		const btn = parent.createEl("button") as HTMLButtonElement;
		btn.setText(`${this.modStr(modifier)}`);
		btn.style.cssText = "padding:2px 8px;border-radius:4px;border:1px solid var(--interactive-accent);background:transparent;color:var(--interactive-accent);font-size:12px;font-weight:700;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap;";
		btn.addEventListener("mouseenter", () => { btn.style.background = "var(--interactive-accent)"; btn.style.color = "var(--text-on-accent)"; });
		btn.addEventListener("mouseleave", () => { btn.style.background = "transparent"; btn.style.color = "var(--interactive-accent)"; });
		btn.addEventListener("click", () => this.rollD20(modifier, label));
		return btn;
	}

	// ── onOpen ───────────────────────────────────────────────────────────────

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.style.cssText = "padding:0;";

		const char = this.char;
		const stats = this.stats;
		const pb = this.pb;

		const classes: DdbClass[] = char.classes ?? [];
		const totalLevel = calcLevel(classes);
		const classString = classes.map((c) => `${c.definition?.name ?? "?"} ${c.level ?? 0}`).join(" / ");
		const raceName = char.race?.fullName ?? char.race?.baseName ?? "Unknown";
		const ac = calcAC(char, stats.dex);
		const speed = char.race?.weightSpeeds?.normal?.walk ?? 30;
		const initMod = this.mod(stats.dex);
		const hpState = this.loadHP();

		const allMods: DdbModifier[] = [
			...(char.modifiers?.class ?? []),
			...(char.modifiers?.race ?? []),
			...(char.modifiers?.background ?? []),
			...(char.modifiers?.feat ?? []),
		];

		// ── Layout: two columns on wide, single on narrow ────────────────────
		const root = contentEl.createEl("div");
		root.style.cssText = "display:grid;grid-template-columns:1fr 300px;grid-template-rows:auto 1fr;gap:0;min-height:600px;";

		const mainCol = root.createEl("div");
		mainCol.style.cssText = "padding:20px 20px 20px 24px;overflow-y:auto;border-right:1px solid var(--background-modifier-border);";

		const sideCol = root.createEl("div");
		sideCol.style.cssText = "padding:16px;overflow-y:auto;background:var(--background-secondary);";

		// ════════════════════════════════════════════════════════════════════
		// HEADER
		// ════════════════════════════════════════════════════════════════════
		const header = mainCol.createEl("div");
		header.style.cssText = "display:flex;align-items:center;gap:16px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--background-modifier-border);";

		if (char.avatarUrl) {
			const avatar = header.createEl("img") as HTMLImageElement;
			avatar.src = char.avatarUrl;
			avatar.style.cssText = "width:64px;height:64px;border-radius:50%;object-fit:cover;border:2px solid var(--interactive-accent);flex-shrink:0;";
		}

		const headerText = header.createEl("div");
		const nameEl = headerText.createEl("div");
		nameEl.setText(char.name ?? "Unknown");
		nameEl.style.cssText = "font-size:22px;font-weight:900;color:var(--text-normal);line-height:1.1;";
		const subEl = headerText.createEl("div");
		subEl.setText(`${classString} • ${raceName} • Level ${totalLevel}`);
		subEl.style.cssText = "font-size:13px;color:var(--text-muted);margin-top:3px;";

		const closeBtn = header.createEl("button");
		closeBtn.setText("✕ Close");
		closeBtn.style.cssText = "margin-left:auto;padding:6px 14px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:12px;cursor:pointer;flex-shrink:0;";
		closeBtn.addEventListener("click", () => this.close());

		// ════════════════════════════════════════════════════════════════════
		// CORE STATS ROW
		// ════════════════════════════════════════════════════════════════════
		const coreSection = this.sectionEl(mainCol, "Core Stats");
		const coreRow = coreSection.createEl("div");
		coreRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
		this.pill(coreRow, "HP", `${hpState.current}/${hpState.max}`, hpState.temp > 0 ? `+${hpState.temp} temp` : undefined);
		this.pill(coreRow, "AC", String(ac));
		this.pill(coreRow, "Speed", `${speed} ft`);
		this.pill(coreRow, "Initiative", this.modStr(initMod));
		this.pill(coreRow, "Prof. Bonus", `+${pb}`);

		// ════════════════════════════════════════════════════════════════════
		// HP TRACKER (inline in sheet)
		// ════════════════════════════════════════════════════════════════════
		const hpSection = this.sectionEl(mainCol, "HP Tracker");
		const hpWrap = hpSection.createEl("div");
		hpWrap.style.cssText = "display:flex;flex-direction:column;gap:8px;max-width:480px;";

		// HP bar
		const barWrap = hpWrap.createEl("div");
		barWrap.style.cssText = "position:relative;height:28px;border-radius:6px;overflow:hidden;background:var(--background-modifier-border);";
		const barFill = barWrap.createEl("div");
		const barLbl = barWrap.createEl("div");
		barLbl.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5);pointer-events:none;";

		let hpSt = { ...hpState };

		const hpPills = coreRow.querySelector("div") as HTMLElement | null;

		const renderHP = () => {
			const pct = Math.max(0, Math.min(100, (hpSt.current / hpSt.max) * 100));
			barFill.style.cssText = `height:100%;width:${pct}%;background:${pct > 50 ? "#4ade80" : pct > 25 ? "#eab308" : "#ef4444"};transition:width .25s ease,background .25s ease;border-radius:6px;`;
			barLbl.setText(`${hpSt.current} / ${hpSt.max} HP${hpSt.temp > 0 ? ` (+${hpSt.temp} temp)` : ""}`);
			// refresh core stat pill
			const hpPillVal = coreRow.querySelector("div div:nth-child(2)") as HTMLElement | null;
			if (hpPillVal) hpPillVal.setText(`${hpSt.current}/${hpSt.max}`);
			// update death save pips
			dsSPips.forEach((p, i) => { p.style.background = i < hpSt.dsS ? "#4ade80" : "transparent"; });
			dsFPips.forEach((p, i) => { p.style.background = i < hpSt.dsF ? "#ef4444" : "transparent"; });
			this.saveHP(hpSt);
		};

		const addHPLog = (msg: string) => {
			const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
			hpSt.log = hpSt.log ?? [];
			hpSt.log.unshift(`[${ts}] ${msg}`);
			if (hpSt.log.length > 20) hpSt.log.length = 20;
		};

		// dmg/heal row
		const dmgRow = hpWrap.createEl("div");
		dmgRow.style.cssText = "display:flex;gap:6px;align-items:center;";
		const amtInput = dmgRow.createEl("input") as HTMLInputElement;
		amtInput.type = "number"; amtInput.min = "0"; amtInput.value = "1";
		amtInput.style.cssText = "width:60px;padding:5px 6px;font-size:14px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);text-align:center;";
		const getAmt = () => Math.max(0, parseInt(amtInput.value, 10) || 0);

		const dmgBtn = dmgRow.createEl("button");
		dmgBtn.setText("⚔️ Damage"); dmgBtn.style.cssText = "flex:1;padding:6px 0;border-radius:5px;border:none;background:#ef4444;color:#fff;font-weight:700;font-size:13px;cursor:pointer;";
		dmgBtn.addEventListener("click", () => {
			const n = getAmt(); const fromT = Math.min(hpSt.temp, n);
			hpSt.temp = hpSt.temp - fromT; hpSt.current = Math.max(0, hpSt.current - (n - fromT));
			addHPLog(`⚔️ −${n} dmg → ${hpSt.current} HP`); renderHP();
		});

		const healBtn = dmgRow.createEl("button");
		healBtn.setText("💚 Heal"); healBtn.style.cssText = "flex:1;padding:6px 0;border-radius:5px;border:none;background:#4ade80;color:#1a1a1a;font-weight:700;font-size:13px;cursor:pointer;";
		healBtn.addEventListener("click", () => {
			const n = getAmt(); hpSt.current = Math.min(hpSt.max, hpSt.current + n);
			addHPLog(`💚 +${n} heal → ${hpSt.current} HP`); renderHP();
		});

		// quick buttons
		const quickRow = hpWrap.createEl("div");
		quickRow.style.cssText = "display:flex;gap:4px;";
		const qBtn = (lbl: string, d: number) => {
			const b = quickRow.createEl("button"); b.setText(lbl);
			b.style.cssText = "flex:1;padding:4px 0;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);font-size:12px;cursor:pointer;";
			b.addEventListener("click", () => {
				if (d < 0) { const ft = Math.min(hpSt.temp,-d); hpSt.temp-=ft; hpSt.current=Math.max(0,hpSt.current-(-d-ft)); addHPLog(`⚔️ ${d} → ${hpSt.current} HP`); }
				else if (d === 0) { hpSt.current=hpSt.max; addHPLog(`✨ Full rest → ${hpSt.max} HP`); }
				else { hpSt.current=Math.min(hpSt.max,hpSt.current+d); addHPLog(`💚 +${d} → ${hpSt.current} HP`); }
				renderHP();
			});
		};
		qBtn("−10",-10); qBtn("−5",-5); qBtn("−1",-1); qBtn("Full",0); qBtn("+1",1); qBtn("+5",5); qBtn("+10",10);

		// temp HP row
		const tmpRow = hpWrap.createEl("div");
		tmpRow.style.cssText = "display:flex;gap:6px;align-items:center;";
		const tmpLbl = tmpRow.createEl("span"); tmpLbl.setText("Temp HP:"); tmpLbl.style.cssText = "font-size:12px;color:var(--text-muted);white-space:nowrap;";
		const tmpInput = tmpRow.createEl("input") as HTMLInputElement;
		tmpInput.type = "number"; tmpInput.min = "0"; tmpInput.value = String(hpSt.temp);
		tmpInput.style.cssText = "width:60px;padding:5px 6px;font-size:13px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);text-align:center;";
		const setTmpBtn = tmpRow.createEl("button"); setTmpBtn.setText("Set"); setTmpBtn.style.cssText = "padding:5px 10px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);font-size:12px;cursor:pointer;";
		setTmpBtn.addEventListener("click", () => { hpSt.temp = Math.max(0, parseInt(tmpInput.value,10)||0); addHPLog(`💙 Temp HP set to ${hpSt.temp}`); renderHP(); });
		const clrTmpBtn = tmpRow.createEl("button"); clrTmpBtn.setText("Clear"); clrTmpBtn.style.cssText = "padding:5px 10px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:12px;cursor:pointer;";
		clrTmpBtn.addEventListener("click", () => { hpSt.temp=0; tmpInput.value="0"; addHPLog("💙 Temp HP cleared"); renderHP(); });

		// death saves
		const dsSect = hpWrap.createEl("div");
		dsSect.style.cssText = "display:flex;gap:16px;align-items:center;flex-wrap:wrap;";
		const dsSPips: HTMLElement[] = [];
		const dsFPips: HTMLElement[] = [];
		const makePips = (color: string, pips: HTMLElement[], get: () => number, set: (n:number) => void) => {
			const grp = dsSect.createEl("div"); grp.style.cssText = "display:flex;align-items:center;gap:5px;";
			for (let i=1;i<=3;i++) {
				const p = grp.createEl("button") as HTMLButtonElement;
				const idx = i;
				p.style.cssText = `width:18px;height:18px;border-radius:50%;border:2px solid ${color};background:transparent;cursor:pointer;transition:background .15s;`;
				p.addEventListener("click", () => { set(get()>=idx ? idx-1 : idx); renderHP(); });
				pips.push(p);
			}
		};
		makePips("#4ade80", dsSPips, () => hpSt.dsS, (n) => { hpSt.dsS=n; });
		makePips("#ef4444", dsFPips, () => hpSt.dsF, (n) => { hpSt.dsF=n; });
		const dsRstBtn = dsSect.createEl("button"); dsRstBtn.setText("Reset Saves");
		dsRstBtn.style.cssText = "padding:3px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:11px;cursor:pointer;";
		dsRstBtn.addEventListener("click", () => { hpSt.dsS=0; hpSt.dsF=0; addHPLog("🔄 Death saves reset"); renderHP(); });

		renderHP();

		// ════════════════════════════════════════════════════════════════════
		// ABILITY SCORES
		// ════════════════════════════════════════════════════════════════════
		const abilSection = this.sectionEl(mainCol, "Ability Scores");
		const abilGrid = abilSection.createEl("div");
		abilGrid.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";

		const abilDefs: Array<{ key: keyof typeof stats; label: string }> = [
			{ key: "str", label: "STR" }, { key: "dex", label: "DEX" },
			{ key: "con", label: "CON" }, { key: "int", label: "INT" },
			{ key: "wis", label: "WIS" }, { key: "cha", label: "CHA" },
		];

		for (const { key, label } of abilDefs) {
			const score = stats[key];
			const modNum = this.mod(score);
			const card = abilGrid.createEl("div");
			card.style.cssText = "display:flex;flex-direction:column;align-items:center;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:8px;padding:10px 14px;min-width:72px;cursor:pointer;transition:border-color .15s;";
			card.addEventListener("mouseenter", () => { card.style.borderColor = "var(--interactive-accent)"; });
			card.addEventListener("mouseleave", () => { card.style.borderColor = "var(--background-modifier-border)"; });
			card.addEventListener("click", () => this.rollD20(modNum, `${label} Check`));
			const lbl = card.createEl("div"); lbl.setText(label); lbl.style.cssText = "font-size:10px;font-weight:700;color:var(--text-muted);text-transform:uppercase;";
			const scoreEl = card.createEl("div"); scoreEl.setText(String(score)); scoreEl.style.cssText = "font-size:22px;font-weight:900;line-height:1.1;";
			const modEl = card.createEl("div"); modEl.setText(this.modStr(modNum)); modEl.style.cssText = "font-size:13px;color:var(--interactive-accent);font-weight:700;";
			const hint = card.createEl("div"); hint.setText("click to roll"); hint.style.cssText = "font-size:9px;color:var(--text-faint);margin-top:2px;";
		}

		// ════════════════════════════════════════════════════════════════════
		// SAVING THROWS
		// ════════════════════════════════════════════════════════════════════
		const saveSection = this.sectionEl(mainCol, "Saving Throws");
		const saveGrid = saveSection.createEl("div");
		saveGrid.style.cssText = "display:grid;grid-template-columns:repeat(3,1fr);gap:6px;";

		const saveDefs: Array<{ key: keyof typeof stats; label: string; subType: string }> = [
			{ key: "str", label: "Strength",     subType: "strength-saving-throws" },
			{ key: "dex", label: "Dexterity",    subType: "dexterity-saving-throws" },
			{ key: "con", label: "Constitution", subType: "constitution-saving-throws" },
			{ key: "int", label: "Intelligence", subType: "intelligence-saving-throws" },
			{ key: "wis", label: "Wisdom",       subType: "wisdom-saving-throws" },
			{ key: "cha", label: "Charisma",     subType: "charisma-saving-throws" },
		];

		for (const { key, label, subType } of saveDefs) {
			const isProficient = allMods.some((m) => m.type === "proficiency" && m.subType === subType);
			const modNum = this.mod(stats[key]) + (isProficient ? pb : 0);
			const row = saveGrid.createEl("div");
			row.style.cssText = "display:flex;align-items:center;justify-content:space-between;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px 10px;";
			const left = row.createEl("div"); left.style.cssText = "display:flex;align-items:center;gap:6px;";
			const dot = left.createEl("span"); dot.setText(isProficient ? "●" : "○"); dot.style.cssText = `color:${isProficient ? "var(--interactive-accent)" : "var(--text-faint)"};font-size:10px;`;
			const _lbl = left.createEl("span"); _lbl.setText(label); _lbl.style.cssText = "font-size:12px;";
			this.rollBtn(row, `${label} Save`, modNum);
		}

		// ════════════════════════════════════════════════════════════════════
		// SKILLS
		// ════════════════════════════════════════════════════════════════════
		const skillSection = this.sectionEl(mainCol, "Skills");
		const skillGrid = skillSection.createEl("div");
		skillGrid.style.cssText = "display:grid;grid-template-columns:repeat(2,1fr);gap:5px;";

		const skillDefs: Array<{ label: string; key: keyof typeof stats; subType: string }> = [
			{ label: "Acrobatics",     key: "dex", subType: "acrobatics" },
			{ label: "Animal Handling",key: "wis", subType: "animal-handling" },
			{ label: "Arcana",         key: "int", subType: "arcana" },
			{ label: "Athletics",      key: "str", subType: "athletics" },
			{ label: "Deception",      key: "cha", subType: "deception" },
			{ label: "History",        key: "int", subType: "history" },
			{ label: "Insight",        key: "wis", subType: "insight" },
			{ label: "Intimidation",   key: "cha", subType: "intimidation" },
			{ label: "Investigation",  key: "int", subType: "investigation" },
			{ label: "Medicine",       key: "wis", subType: "medicine" },
			{ label: "Nature",         key: "int", subType: "nature" },
			{ label: "Perception",     key: "wis", subType: "perception" },
			{ label: "Performance",    key: "cha", subType: "performance" },
			{ label: "Persuasion",     key: "cha", subType: "persuasion" },
			{ label: "Religion",       key: "int", subType: "religion" },
			{ label: "Sleight of Hand",key: "dex", subType: "sleight-of-hand" },
			{ label: "Stealth",        key: "dex", subType: "stealth" },
			{ label: "Survival",       key: "wis", subType: "survival" },
		];

		for (const { label, key, subType } of skillDefs) {
			const isProficient = allMods.some((m) => m.type === "proficiency" && m.subType === subType);
			const isExpertise  = allMods.some((m) => m.type === "expertise"   && m.subType === subType);
			const bonus = this.mod(stats[key]) + (isExpertise ? pb * 2 : isProficient ? pb : 0);
			const row = skillGrid.createEl("div");
			row.style.cssText = "display:flex;align-items:center;justify-content:space-between;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:5px;padding:5px 8px;";
			const left = row.createEl("div"); left.style.cssText = "display:flex;align-items:center;gap:5px;";
			const dot = left.createEl("span");
			dot.setText(isExpertise ? "★" : isProficient ? "●" : "○");
			dot.style.cssText = `color:${isExpertise ? "#f59e0b" : isProficient ? "var(--interactive-accent)" : "var(--text-faint)"};font-size:10px;`;
			const _lbl = left.createEl("span"); _lbl.setText(label); _lbl.style.cssText = "font-size:12px;";
			this.rollBtn(row, `${label} Check`, bonus);
		}

		// ════════════════════════════════════════════════════════════════════
		// ACTIONS & ATTACKS
		// ════════════════════════════════════════════════════════════════════
		const actions = extractActions(char, stats, pb);
		if (actions.length) {
			const actSection = this.sectionEl(mainCol, "Actions & Attacks");
			for (const action of actions) {
				const row = actSection.createEl("div");
				row.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:6px;padding:8px 12px;margin-bottom:6px;";
				const nameEl = row.createEl("span");
				nameEl.setText(`${action.isSpell ? "✨" : "⚔️"} ${action.name}`);
				nameEl.style.cssText = "flex:1;font-size:13px;font-weight:600;";
				if (action.notes) {
					const notesEl = row.createEl("span"); notesEl.setText(action.notes);
					notesEl.style.cssText = "font-size:11px;color:var(--text-muted);";
				}
				if (action.attackBonus != null) {
					const atkBtn = row.createEl("button");
					atkBtn.setText(`🎲 ATK ${this.modStr(action.attackBonus)}`);
					atkBtn.style.cssText = "padding:4px 10px;border-radius:5px;border:none;background:var(--interactive-accent);color:var(--text-on-accent);font-size:12px;font-weight:700;cursor:pointer;";
					atkBtn.addEventListener("click", () => this.rollD20(action.attackBonus!, `${action.name} Attack`));
				}
				const hasDmg = action.damageDice != null || action.damageBonus !== 0;
				if (hasDmg) {
					const dmgStr = action.damageDice
						? `${action.damageDice}${action.damageBonus !== 0 ? this.modStr(action.damageBonus) : ""}`
						: `${action.damageBonus}`;
					const dmgBtn = row.createEl("button");
					dmgBtn.setText(`🎲 DMG ${dmgStr}`);
					dmgBtn.style.cssText = "padding:4px 10px;border-radius:5px;border:none;background:#ef4444;color:#fff;font-size:12px;font-weight:700;cursor:pointer;";
					dmgBtn.addEventListener("click", () => this.rollDamage(action.damageDice, action.damageBonus, action.name));

					// 5etools weapon lookup
					if (this.plugin.settings.fiveEtoolsEnabled) {
						const infoBtn = row.createEl("button"); infoBtn.setText("📖");
						infoBtn.title = "Fetch from 5etools";
						infoBtn.style.cssText = "padding:4px 8px;border-radius:5px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:12px;cursor:pointer;";
						infoBtn.addEventListener("click", async () => {
							infoBtn.setText("⏳"); infoBtn.disabled = true;
							const entry = await fetch5eData(this.plugin.settings.fiveEtoolsBaseUrl, "items", action.name);
							infoBtn.setText("📖"); infoBtn.disabled = false;
							if (!entry) { new Notice(`No 5etools entry found for "${action.name}"`, 2000); return; }
							new FiveEDataModal(this.app, action.name, render5eDescription(entry)).open();
						});
					}
				}
			}
		}

		// ════════════════════════════════════════════════════════════════════
		// SPELL SLOTS + SPELLS
		// ════════════════════════════════════════════════════════════════════
		const spellSlots = char.spellSlots;
		if (spellSlots) {
			const slots: DdbSpellSlot[] = Array.isArray(spellSlots) ? spellSlots : Object.values(spellSlots);
			const usefulSlots = slots.filter((s) => s.max);
			if (usefulSlots.length) {
				const slotSection = this.sectionEl(mainCol, "Spell Slots");
				const slotKey = `dnd-slots-${char.id}`;
				const loadSlots = (): Record<number, number> => {
					try { return JSON.parse(this.plugin.sessionState.get(slotKey) ?? "null") ?? {}; } catch { return {}; }
				};
				const saveSlots = (d: Record<number, number>) => this.plugin.sessionState.set(slotKey, JSON.stringify(d));
				let usedSlots: Record<number, number> = loadSlots();

				for (const slot of usefulSlots) {
					const lvl = slot.level ?? 0;
					const maxPips = slot.max ?? 0;
					const slotRow = slotSection.createEl("div");
					slotRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:8px;";
					const lvlLbl = slotRow.createEl("span"); lvlLbl.setText(`Level ${lvl}`);
					lvlLbl.style.cssText = "font-size:12px;color:var(--text-muted);width:52px;flex-shrink:0;";
					const pipsEl = slotRow.createEl("div"); pipsEl.style.cssText = "display:flex;gap:5px;";
					const restBtn = slotRow.createEl("button"); restBtn.setText("Rest"); restBtn.style.cssText = "margin-left:auto;padding:3px 8px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:11px;cursor:pointer;";

					const renderPips = () => {
						pipsEl.empty();
						const used = usedSlots[lvl] ?? 0;
						for (let i = 0; i < maxPips; i++) {
							const pip = pipsEl.createEl("button") as HTMLButtonElement;
							const isUsed = i < used;
							pip.style.cssText = `width:18px;height:18px;border-radius:50%;border:2px solid var(--interactive-accent);background:${isUsed ? "var(--background-modifier-border)" : "var(--interactive-accent)"};cursor:pointer;transition:background .15s;`;
							const idx = i;
							pip.addEventListener("click", () => {
								const cur = usedSlots[lvl] ?? 0;
								// clicking a used pip restores it; clicking unused marks it used
								usedSlots[lvl] = isUsed ? Math.max(0, cur - 1) : Math.min(maxPips, cur + 1);
								saveSlots(usedSlots); renderPips();
							});
						}
					};

					restBtn.addEventListener("click", () => { usedSlots[lvl] = 0; saveSlots(usedSlots); renderPips(); });
					renderPips();
				}
			}
		}

		// Spells list
		const allSpells: DdbSpell[] = [];
		if (Array.isArray(char.classSpells)) {
			for (const cs of char.classSpells) for (const s of cs.spells ?? []) allSpells.push(s);
		}
		for (const src of ["race","background","feat","class","item"]) {
			for (const s of char.spells?.[src] ?? []) allSpells.push(s);
		}

		if (allSpells.length) {
			const spellSection = this.sectionEl(mainCol, "Spells");
			const byLevel: Map<number, DdbSpell[]> = new Map();
			for (const s of allSpells) {
				const lvl = s.definition?.level ?? 0;
				if (!byLevel.has(lvl)) byLevel.set(lvl, []);
				byLevel.get(lvl)!.push(s);
			}
			const levelNames = ["Cantrips","1st","2nd","3rd","4th","5th","6th","7th","8th","9th"];

			for (const [lvl, spells] of [...byLevel.entries()].sort((a,b) => a[0]-b[0])) {
				const lvlHdr = spellSection.createEl("div"); lvlHdr.setText(levelNames[lvl] ?? `Level ${lvl}`);
				lvlHdr.style.cssText = "font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin:8px 0 4px 0;";
				for (const spell of spells) {
					const def = spell.definition; if (!def) continue;
					const sRow = spellSection.createEl("div");
					sRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;margin-bottom:3px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);cursor:pointer;transition:border-color .15s;";
					sRow.addEventListener("mouseenter", () => { sRow.style.borderColor = "var(--interactive-accent)"; });
					sRow.addEventListener("mouseleave", () => { sRow.style.borderColor = "var(--background-modifier-border)"; });

					const prepDot = sRow.createEl("span"); prepDot.setText(spell.prepared ? "●" : "○");
					prepDot.style.cssText = `color:${spell.prepared ? "var(--interactive-accent)" : "var(--text-faint)"};font-size:10px;flex-shrink:0;`;
					const spellName = sRow.createEl("span"); spellName.setText(def.name ?? "Unknown");
					spellName.style.cssText = "flex:1;font-size:13px;font-weight:600;";
					const school = sRow.createEl("span"); school.setText(def.school ?? "");
					school.style.cssText = "font-size:11px;color:var(--text-muted);";
					if (def.concentration) {
						const conc = sRow.createEl("span"); conc.setText("C"); conc.style.cssText = "font-size:10px;color:#f59e0b;font-weight:700;border:1px solid #f59e0b;border-radius:3px;padding:0 3px;";
					}

					// Expand/5etools on click
					const descEl = spellSection.createEl("div");
					descEl.style.cssText = "display:none;padding:8px 12px;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-top:none;border-radius:0 0 5px 5px;font-size:12px;color:var(--text-normal);white-space:pre-wrap;margin-bottom:4px;";
					let expanded = false;
					let fetched = false;

					sRow.addEventListener("click", async () => {
						expanded = !expanded;
						descEl.style.display = expanded ? "block" : "none";
						if (expanded && !fetched) {
							fetched = true;
							if (def.description) {
								descEl.setText(stripHtml(def.description));
							} else if (this.plugin.settings.fiveEtoolsEnabled) {
								descEl.setText("⏳ Fetching from 5etools…");
								const entry = await fetch5eData(this.plugin.settings.fiveEtoolsBaseUrl, "spells", def.name ?? "");
								descEl.setText(entry ? render5eDescription(entry) : "No description available.");
							} else {
								descEl.setText("No description available. Enable 5etools integration in settings to fetch spell descriptions.");
							}
						}
					});
				}
			}
		}

		// ════════════════════════════════════════════════════════════════════
		// EQUIPMENT
		// ════════════════════════════════════════════════════════════════════
		const inventory = char.inventory ?? [];
		if (inventory.length) {
			const eqSection = this.sectionEl(mainCol, "Equipment");
			const eqKey = `dnd-eq-${char.id}`;
			const loadEq = (): Record<string, boolean> => { try { return JSON.parse(this.plugin.sessionState.get(eqKey) ?? "null") ?? {}; } catch { return {}; } };
			const saveEq = (d: Record<string, boolean>) => this.plugin.sessionState.set(eqKey, JSON.stringify(d));
			let eqState: Record<string, boolean> = loadEq();

			for (const item of inventory) {
				const def = item.definition; if (!def) continue;
				const key = (def.name ?? "unknown").toLowerCase().replace(/\s+/g, "-");
				if (!(key in eqState)) eqState[key] = item.equipped ?? false;

				const iRow = eqSection.createEl("div");
				iRow.style.cssText = "display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:5px;margin-bottom:3px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);";
				const toggle = iRow.createEl("button") as HTMLButtonElement;
				const renderToggle = () => {
					toggle.setText(eqState[key] ? "⚔️" : "🎒");
					toggle.title = eqState[key] ? "Equipped — click to unequip" : "Unequipped — click to equip";
					iRow.style.opacity = eqState[key] ? "1" : "0.55";
				};
				toggle.style.cssText = "border:none;background:transparent;cursor:pointer;font-size:16px;padding:0;line-height:1;";
				toggle.addEventListener("click", () => { eqState[key] = !eqState[key]; saveEq(eqState); renderToggle(); });
				renderToggle();

				const itemName = iRow.createEl("span"); itemName.setText(def.name ?? "Unknown");
				itemName.style.cssText = "flex:1;font-size:13px;";
				const qty = iRow.createEl("span"); qty.setText(`×${item.quantity ?? 1}`);
				qty.style.cssText = "font-size:12px;color:var(--text-muted);";
				if (def.weight) {
					const wt = iRow.createEl("span"); wt.setText(`${def.weight} lb`);
					wt.style.cssText = "font-size:11px;color:var(--text-faint);";
				}

				// 5etools item lookup
				if (this.plugin.settings.fiveEtoolsEnabled) {
					const infoBtn = iRow.createEl("button"); infoBtn.setText("📖"); infoBtn.title = "Fetch from 5etools";
					infoBtn.style.cssText = "border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);border-radius:4px;font-size:12px;cursor:pointer;padding:2px 6px;";
					infoBtn.addEventListener("click", async () => {
						infoBtn.setText("⏳"); infoBtn.disabled = true;
						const entry = await fetch5eData(this.plugin.settings.fiveEtoolsBaseUrl, "items", def.name ?? "");
						infoBtn.setText("📖"); infoBtn.disabled = false;
						if (!entry) { new Notice(`No 5etools entry for "${def.name}"`, 2000); return; }
						new FiveEDataModal(this.app, def.name ?? "Item", render5eDescription(entry)).open();
					});
				}
			}
		}

		// ════════════════════════════════════════════════════════════════════
		// FEATURES & TRAITS (expandable, with 5etools lookup)
		// ════════════════════════════════════════════════════════════════════
		const racialTraits = char.race?.racialTraits ?? [];
		const feats: DdbFeat[] = char.feats ?? [];

		if (racialTraits.length || feats.length) {
			const featSection = this.sectionEl(mainCol, "Features & Traits");

			const makeFeat = (name: string, rawDesc: string | undefined, fetchType: "classfeature" | "races") => {
				const card = featSection.createEl("div");
				card.style.cssText = "border:1px solid var(--background-modifier-border);border-radius:6px;margin-bottom:6px;overflow:hidden;";
				const hdr = card.createEl("div");
				hdr.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;background:var(--background-secondary);";
				const _hdrSpan = hdr.createEl("span"); _hdrSpan.setText(name); _hdrSpan.style.cssText = "font-size:13px;font-weight:600;";
				const chevron = hdr.createEl("span"); chevron.setText("▶"); chevron.style.cssText = "color:var(--text-muted);font-size:10px;transition:transform .2s;";

				const body = card.createEl("div");
				body.style.cssText = "display:none;padding:10px 12px;font-size:12px;color:var(--text-normal);white-space:pre-wrap;background:var(--background-primary);";

				let expanded = false; let fetched = false;

				hdr.addEventListener("click", async () => {
					expanded = !expanded;
					body.style.display = expanded ? "block" : "none";
					chevron.style.transform = expanded ? "rotate(90deg)" : "none";
					if (expanded && !fetched) {
						fetched = true;
						if (rawDesc) {
							body.setText(stripHtml(rawDesc));
						} else if (this.plugin.settings.fiveEtoolsEnabled) {
							body.setText("⏳ Fetching from 5etools…");
							const entry = await fetch5eData(this.plugin.settings.fiveEtoolsBaseUrl, fetchType, name);
							body.setText(entry ? render5eDescription(entry) : "No description available.");
						} else {
							body.setText("Enable 5etools integration in settings to fetch descriptions.");
						}
					}
				});

				if (this.plugin.settings.fiveEtoolsEnabled) {
					const fetchBtn = hdr.createEl("button"); fetchBtn.setText("📖"); fetchBtn.title = "Refresh from 5etools";
					fetchBtn.style.cssText = "border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);border-radius:4px;font-size:11px;cursor:pointer;padding:2px 5px;margin-left:8px;";
					fetchBtn.addEventListener("click", async (e) => {
						e.stopPropagation();
						fetchBtn.setText("⏳"); fetchBtn.setAttribute("disabled","");
						const entry = await fetch5eData(this.plugin.settings.fiveEtoolsBaseUrl, fetchType, name);
						fetchBtn.setText("📖"); fetchBtn.removeAttribute("disabled");
						body.setText(entry ? render5eDescription(entry) : "No entry found.");
						body.style.display = "block"; expanded = true; chevron.style.transform = "rotate(90deg)";
					});
				}
			};

			for (const t of racialTraits) {
				if (t.definition?.name) makeFeat(t.definition.name, t.definition.description, "races");
			}
			for (const f of feats) {
				if (f.definition?.name) makeFeat(f.definition.name, f.definition.description, "classfeature");
			}
		}

		// ════════════════════════════════════════════════════════════════════
		// CLASS FEATURES (expandable, with 5etools lookup)
		// ════════════════════════════════════════════════════════════════════
		const classFeatureSection = this.sectionEl(mainCol, "Class Features");
		for (const cls of char.classes ?? []) {
			const className = cls.definition?.name ?? "Unknown";
			const clsHdr = classFeatureSection.createEl("div"); clsHdr.setText(`${className} (Level ${cls.level ?? 0})`);
			clsHdr.style.cssText = "font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;margin:6px 0 4px 0;";
		}

		// ════════════════════════════════════════════════════════════════════
		// SESSION NOTES (editable, persisted)
		// ════════════════════════════════════════════════════════════════════
		const notesSection = this.sectionEl(mainCol, "Session Notes");
		const notesKey = `dnd-notes-${char.id}`;
		const notesArea = notesSection.createEl("textarea") as HTMLTextAreaElement;
		notesArea.value = this.plugin.sessionState.get(notesKey) ?? "";
		notesArea.placeholder = "Add your session notes here…";
		notesArea.style.cssText = "width:100%;min-height:100px;padding:8px;border-radius:6px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-normal);font-size:13px;font-family:var(--font-text);resize:vertical;box-sizing:border-box;";
		notesArea.addEventListener("input", () => this.plugin.sessionState.set(notesKey, notesArea.value));

		// ════════════════════════════════════════════════════════════════════
		// SIDEBAR: Roll Log + Currency + Proficiencies
		// ════════════════════════════════════════════════════════════════════
		const rollSection = this.sectionEl(sideCol, "Roll Log");
		const clearRollBtn = rollSection.createEl("button"); clearRollBtn.setText("Clear");
		clearRollBtn.style.cssText = "float:right;padding:2px 7px;border-radius:4px;border:1px solid var(--background-modifier-border);background:var(--background-primary);color:var(--text-muted);font-size:11px;cursor:pointer;margin-top:-24px;";
		clearRollBtn.addEventListener("click", () => { this.rollLog = []; this.refreshRollLog(); });
		const rollLogContainer = rollSection.createEl("div");
		rollLogContainer.style.cssText = "max-height:220px;overflow-y:auto;";
		this.rollLogEl = rollLogContainer;
		this.refreshRollLog();

		// Currency
		const curr = char.currencies;
		if (curr) {
			const currSection = this.sectionEl(sideCol, "Currency");
			const currRow = currSection.createEl("div"); currRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
			const coin = (lbl: string, val: number, color: string) => {
				const c = currRow.createEl("div"); c.style.cssText = `display:flex;flex-direction:column;align-items:center;background:var(--background-primary);border:1px solid ${color};border-radius:6px;padding:6px 10px;min-width:44px;`;
				const _cv = c.createEl("span"); _cv.setText(String(val)); _cv.style.cssText = "font-size:16px;font-weight:700;";
				const _cl = c.createEl("span"); _cl.setText(lbl); _cl.style.cssText = `font-size:10px;color:${color};font-weight:700;`;
			};
			coin("CP", curr.cp ?? 0, "#a16207");
			coin("SP", curr.sp ?? 0, "#6b7280");
			coin("EP", curr.ep ?? 0, "#0891b2");
			coin("GP", curr.gp ?? 0, "#d97706");
			coin("PP", curr.pp ?? 0, "#7c3aed");
		}

		// Proficiencies & Languages
		const profSection = this.sectionEl(sideCol, "Proficiencies & Languages");
		const profNames = allMods
			.filter((m) => m.type === "proficiency" && m.friendlySubtypeName)
			.map((m) => m.friendlySubtypeName ?? "")
			.filter((v, i, a) => v && a.indexOf(v) === i);
		if (profNames.length) {
			const profList = profSection.createEl("div"); profList.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;";
			profNames.forEach((p) => {
				const chip = profList.createEl("span"); chip.setText(p);
				chip.style.cssText = "background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:12px;padding:2px 8px;font-size:11px;color:var(--text-normal);";
			});
		}

		// 5etools status badge
		if (this.plugin.settings.fiveEtoolsEnabled) {
			const badge = sideCol.createEl("div");
			badge.style.cssText = "margin-top:auto;padding:8px;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:6px;font-size:11px;color:var(--text-muted);text-align:center;";
			badge.setText(`📖 5etools: ${this.plugin.settings.fiveEtoolsBaseUrl}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
		this.rollLogEl = null;
	}
}

// ─── 5etools Data Popup Modal ──────────────────────────────────────────────────

class FiveEDataModal extends Modal {
	title: string;
	content: string;
	constructor(app: App, title: string, content: string) {
		super(app); this.title = title; this.content = content;
	}
	onOpen(): void {
		this.contentEl.createEl("h3", { text: this.title });
		const pre = this.contentEl.createEl("div");
		pre.style.cssText = "white-space:pre-wrap;font-size:13px;color:var(--text-normal);max-height:400px;overflow-y:auto;";
		pre.setText(this.content);
	}
	onClose(): void { this.contentEl.empty(); }
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

		// ── 5etools integration ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Enable 5etools integration")
			.setDesc("Fetch rich descriptions for spells, items, class features, and racial traits from your self-hosted 5etools instance. Disabled by default.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.fiveEtoolsEnabled)
					.onChange(async (value) => {
						this.plugin.settings.fiveEtoolsEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("5etools base URL")
			.setDesc("Base URL of your self-hosted 5etools instance (e.g. https://5e.tools or http://localhost:5000). Only used when the integration is enabled.")
			.addText((text) =>
				text
					.setPlaceholder("https://5e.tools")
					.setValue(this.plugin.settings.fiveEtoolsBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.fiveEtoolsBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
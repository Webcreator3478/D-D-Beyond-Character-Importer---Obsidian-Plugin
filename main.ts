import {
	App,
	Modal,
	Notice,
	normalizePath,
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
	item?: DdbModifier[];
	condition?: DdbModifier[];
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

/**
 * Returns every modifier granted to a character from all sources:
 * class, race, background, feats, and equipped/attuned items.
 * Use this instead of re-building the spread in every function.
 */
function getAllModifiers(char: DdbCharacter): DdbModifier[] {
	return [
		...(char.modifiers?.class ?? []),
		...(char.modifiers?.race ?? []),
		...(char.modifiers?.background ?? []),
		...(char.modifiers?.feat ?? []),
		...(char.modifiers?.item ?? []),
	];
}

// Advantage/disadvantage on a saving throw or skill check. Checks both the
// specific subType (e.g. "perception") and the broad subType D&D Beyond uses
// for blanket grants (e.g. "saving-throws" / "ability-checks"). Per 5e rules,
// if a creature has both advantage and disadvantage on the same roll they
// cancel out, so that case resolves to "none" — same as having neither.
// Every roll always resolves to one of the three states; nothing is ever
// "no status" — it's an explicit import of what D&D Beyond reports.
type AdvState = "advantage" | "disadvantage" | "none";

function getAdvantageState(allMods: DdbModifier[], subType: string, broadSubType: string): AdvState {
	const hasAdv = allMods.some((m) => m.type === "advantage" && (m.subType === subType || m.subType === broadSubType));
	const hasDis = allMods.some((m) => m.type === "disadvantage" && (m.subType === subType || m.subType === broadSubType));
	if (hasAdv && hasDis) return "none";
	if (hasAdv) return "advantage";
	if (hasDis) return "disadvantage";
	return "none";
}

// Always renders a marker — every roll has an explicit imported status,
// including "none", not just the advantage/disadvantage cases.
function formatAdvMarkerMd(advState: AdvState): string {
	if (advState === "advantage") return ` <span style="color:#22c55e;font-weight:700;">▲A</span>`;
	if (advState === "disadvantage") return ` <span style="color:#ef4444;font-weight:700;">▼D</span>`;
	return ` <span style="color:#9ca3af;">–N</span>`;
}

function calcHP(char: DdbCharacter, conScore: number, totalLevel: number, allMods: DdbModifier[]): { max: number; current: number; temp: number } {
	const base = char.baseHitPoints ?? 0;
	const bonus = char.bonusHitPoints ?? 0;
	const override = char.overrideHitPoints;
	const removedHp = char.removedHitPoints ?? 0;
	const temp = char.temporaryHitPoints ?? 0;
	const conMod = Math.floor((conScore - 10) / 2);
	// Per-level HP bonuses (Tough feat +2/level, Dwarven Toughness +1/level, etc.)
	const hpPerLevel = allMods
		.filter((m) => m.type === "bonus" && m.subType === "hit-points-per-level" && m.value != null)
		.reduce((sum, m) => sum + (m.value ?? 0), 0);
	// Flat HP bonuses
	const flatHp = allMods
		.filter((m) => m.type === "bonus" && m.subType === "hit-points" && m.value != null)
		.reduce((sum, m) => sum + (m.value ?? 0), 0);
	// If the user has manually overridden HP in D&D Beyond we use that value as-is.
	// This intentionally skips Con-mod scaling, Tough/Dwarven Toughness bonuses, and
	// flatHp — the override is the user's explicit total, not a base to add on top of.
	const max = override != null ? override : base + bonus + conMod * totalLevel + hpPerLevel * totalLevel + flatHp;
	return { max, current: max - removedHp, temp };
}

function calcLevel(classes: DdbClass[]): number {
	return classes.reduce((sum, c) => sum + (c.level ?? 0), 0);
}

function calcAC(char: DdbCharacter, dexScore: number, allStats: Record<number, number>, allMods: DdbModifier[]): number {
	const dexMod = Math.floor((dexScore - 10) / 2);
	const conMod = Math.floor(((allStats[3] ?? 10) - 10) / 2);
	const wisMod = Math.floor(((allStats[5] ?? 10) - 10) / 2);
	let bestAC = 10 + dexMod;
	let shieldBonus = 0;
	let wearingArmor = false;
	for (const item of char.inventory ?? []) {
		const def = item.definition;
		if (!def || !item.equipped) continue;
		if (def.armorClass) {
			if (def.armorTypeId === 4) {
				shieldBonus = Math.max(shieldBonus, def.armorClass);
			} else {
				wearingArmor = true;
				const addDex = def.armorTypeId !== 3;
				const maxDex = def.armorTypeId === 2 ? 2 : 999;
				const ac = def.armorClass + (addDex ? Math.min(dexMod, maxDex) : 0);
				if (ac > bestAC) bestAC = ac;
			}
		}
	}
	// Unarmored defense: Barbarian (10+DEX+CON), Monk (10+DEX+WIS).
	// Shields are NOT armor (armorTypeId 4 is tracked separately as shieldBonus), so
	// wearingArmor stays false when only a shield is equipped — allowing unarmored
	// defense to apply. The shield bonus is still added at the end either way.
	if (!wearingArmor) {
		for (const m of allMods) {
			if (m.subType === "unarmored-defense-constitution")
				bestAC = Math.max(bestAC, 10 + dexMod + conMod);
			if (m.subType === "unarmored-defense-wisdom")
				bestAC = Math.max(bestAC, 10 + dexMod + wisMod);
		}
	}
	// Flat AC bonuses: Defense fighting style (+1), feats, magic items, etc.
	for (const m of allMods) {
		if (m.type === "bonus" && m.subType === "armor-class" && m.value != null)
			bestAC += m.value;
	}
	return bestAC + shieldBonus;
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

// Modifiers (feats, race, class, background) can grant flat bonuses to ability scores.
// bonusStats from the API is typically all-null; the real bonuses live in modifiers[*].
// Shared by buildMarkdown() and Plugin.importCharacter() (which needs the raw scores
// again to populate charCache for the Interactive Character Sheet).
function computeRawStats(char: DdbCharacter): Record<string, number> {
	const statSubTypeToId: Record<string, number> = {
		"strength-score": 1, "dexterity-score": 2, "constitution-score": 3,
		"intelligence-score": 4, "wisdom-score": 5, "charisma-score": 6,
	};
	const allModifiers = getAllModifiers(char);
	const modifierStatBonuses: DdbStat[] = allModifiers
		.filter((m) => m.type === "bonus" && m.subType in statSubTypeToId && m.value != null)
		.map((m) => ({ id: statSubTypeToId[m.subType], value: m.value! }));
	const effectiveBonusStats = [
		...(char.bonusStats ?? []).filter((s) => s.value != null),
		...modifierStatBonuses,
	];
	return {
		str: getStatValue(char.stats ?? [], char.overrideStats ?? [], effectiveBonusStats, 1),
		dex: getStatValue(char.stats ?? [], char.overrideStats ?? [], effectiveBonusStats, 2),
		con: getStatValue(char.stats ?? [], char.overrideStats ?? [], effectiveBonusStats, 3),
		int: getStatValue(char.stats ?? [], char.overrideStats ?? [], effectiveBonusStats, 4),
		wis: getStatValue(char.stats ?? [], char.overrideStats ?? [], effectiveBonusStats, 5),
		cha: getStatValue(char.stats ?? [], char.overrideStats ?? [], effectiveBonusStats, 6),
	};
}

function buildMarkdown(
	data: DdbApiResponse,
	settings: DnDBeyondImporterSettings
): string {
	const char = data.data;
	if (!char) throw new Error("Unexpected API response structure");

	const classes: DdbClass[] = char.classes ?? [];
	const totalLevel = calcLevel(classes);
	const pb = profBonus(totalLevel);

	const rawStats = computeRawStats(char);
	const allModifiers = getAllModifiers(char);

	const rawStatsById: Record<number, number> = { 1: rawStats.str, 2: rawStats.dex, 3: rawStats.con, 4: rawStats.int, 5: rawStats.wis, 6: rawStats.cha };
	const hp = calcHP(char, rawStats.con, totalLevel, allModifiers);
	const ac = calcAC(char, rawStats.dex, rawStatsById, allModifiers);

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

	const allMods = getAllModifiers(char);
	const cells = statKeys.map(({ key, subType }) => {
		const statVal = stats[key] ?? 10;
		const base = Math.floor((statVal - 10) / 2);
		const isProficient = allMods.some(
			(m) => m.type === "proficiency" && m.subType === subType
		);
		const total = isProficient ? base + pb : base;
		const str = total >= 0 ? `+${total}` : `${total}`;
		const advState = getAdvantageState(allMods, subType, "saving-throws");
		const advMarker = formatAdvMarkerMd(advState);
		return (isProficient ? `**${str}** ✓` : str) + advMarker;
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

	const allMods = getAllModifiers(char);

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
		const advState = getAdvantageState(allMods, skill.key, "ability-checks");
		const advMarker = formatAdvMarkerMd(advState);
		md += `| ${skill.name}${marker} | ${skill.stat.toUpperCase()} | ${bonusStr}${advMarker} |\n`;
	}

	md += "\n*✓ = Proficient, ★ = Expertise, ▲A = Advantage, –N = None, ▼D = Disadvantage*\n\n";
	return md;
}

function buildProficiencies(char: DdbCharacter): string {
	const allMods = getAllModifiers(char);

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

// ─── Import Modal ─────────────────────────────────────────────────────────────

class ImportModal extends Modal {
	plugin: InstanceType<typeof Plugin> & {
		importCharacter: (url: string) => Promise<void>;
		hpTracking: Map<string, { maxHp: number; currentHp: number; tempHp: number }>;
	};
	private urlValue = "";

	constructor(app: App, plugin: ImportModal["plugin"]) {
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
			cls: "dndbi-import-input",
		});

		input.addEventListener("input", (e) => {
			this.urlValue = (e.target as HTMLInputElement).value;
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				this.submit().catch((err: unknown) => {
					console.error("Import failed:", err);
				});
			}
		});

		const btnRow = contentEl.createEl("div", { cls: "dndbi-import-btn-row" });

		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const importBtn = btnRow.createEl("button", {
			text: "Import",
			cls: "mod-cta",
		});
		importBtn.addEventListener("click", () => {
			this.submit().catch((err: unknown) => {
				console.error("Import failed:", err);
			});
		});

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
	plugin: InstanceType<typeof Plugin> & {
		hpTracking: Map<string, { maxHp: number; currentHp: number; tempHp: number }>;
	};
	characterId: string;

	constructor(app: App, plugin: HPTrackerModal["plugin"], characterId: string) {
		super(app);
		this.plugin = plugin;
		this.characterId = characterId;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "❤️ HP Tracker" });

		let tracker = this.plugin.hpTracking.get(this.characterId);
		if (!tracker) {
			tracker = { maxHp: 30, currentHp: 30, tempHp: 0 };
			this.plugin.hpTracking.set(this.characterId, tracker);
		}

		// ── HP Display ───────────────────────────────────────────────────────
		const displayEl = contentEl.createEl("div", { cls: "dndbi-hpmodal-display" });

		const hpBarEl = displayEl.createEl("div", { cls: "dndbi-hpmodal-bar-wrap" });

		const hpFillEl = hpBarEl.createEl("div", { cls: "dndbi-hpmodal-bar-fill" });

		const hpTextEl = displayEl.createEl("div", { cls: "dndbi-hpmodal-text" });

		const tempEl = displayEl.createEl("div", { cls: "dndbi-hpmodal-temp" });

		const updateDisplay = () => {
			const total = tracker.currentHp + tracker.tempHp;
			hpTextEl.setText(`${total}/${tracker.maxHp} HP`);
			tempEl.setText(tracker.tempHp > 0 ? `Temp: ${tracker.tempHp}` : "");

			const newPercent = Math.max(0, (tracker.currentHp / tracker.maxHp) * 100);
			hpFillEl.setCssStyles({ width: `${newPercent}%` });
			hpFillEl.removeClass("dndbi-hpmodal-bar-fill--high", "dndbi-hpmodal-bar-fill--mid", "dndbi-hpmodal-bar-fill--low");
			if (newPercent > 50) {
				hpFillEl.addClass("dndbi-hpmodal-bar-fill--high");
			} else if (newPercent > 25) {
				hpFillEl.addClass("dndbi-hpmodal-bar-fill--mid");
			} else {
				hpFillEl.addClass("dndbi-hpmodal-bar-fill--low");
			}
		};

		// ── Current HP Controls ──────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Current HP" });

		const currentCtrlEl = contentEl.createEl("div", { cls: "dndbi-hpmodal-ctrl-row" });

		const currentInputEl = activeDocument.createElement("input");
		currentInputEl.className = "dndbi-hpmodal-number-input";
		currentInputEl.type = "number";
		currentInputEl.value = String(tracker.currentHp);
		currentInputEl.min = "0";
		currentInputEl.max = String(tracker.maxHp);
		currentCtrlEl.appendChild(currentInputEl);
		currentInputEl.addEventListener("change", () => {
			tracker.currentHp = Math.max(0, Math.min(tracker.maxHp, Number(currentInputEl.value)));
			updateDisplay();
		});

		const minusBtn = currentCtrlEl.createEl("button", { text: "−5", cls: "dndbi-hpmodal-step-btn" });
		minusBtn.addEventListener("click", () => {
			tracker.currentHp = Math.max(0, tracker.currentHp - 5);
			currentInputEl.value = String(tracker.currentHp);
			updateDisplay();
		});

		const minusOneBtn = currentCtrlEl.createEl("button", { text: "−1", cls: "dndbi-hpmodal-step-btn" });
		minusOneBtn.addEventListener("click", () => {
			tracker.currentHp = Math.max(0, tracker.currentHp - 1);
			currentInputEl.value = String(tracker.currentHp);
			updateDisplay();
		});

		const plusOneBtn = currentCtrlEl.createEl("button", { text: "+1", cls: "dndbi-hpmodal-step-btn" });
		plusOneBtn.addEventListener("click", () => {
			tracker.currentHp = Math.min(tracker.maxHp, tracker.currentHp + 1);
			currentInputEl.value = String(tracker.currentHp);
			updateDisplay();
		});

		const plusFiveBtn = currentCtrlEl.createEl("button", { text: "+5", cls: "dndbi-hpmodal-step-btn" });
		plusFiveBtn.addEventListener("click", () => {
			tracker.currentHp = Math.min(tracker.maxHp, tracker.currentHp + 5);
			currentInputEl.value = String(tracker.currentHp);
			updateDisplay();
		});

		// ── Temporary HP Controls ────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Temporary HP" });

		const tempCtrlEl = contentEl.createEl("div", { cls: "dndbi-hpmodal-ctrl-row" });

		const tempInputEl = activeDocument.createElement("input");
		tempInputEl.className = "dndbi-hpmodal-number-input";
		tempInputEl.type = "number";
		tempInputEl.value = String(tracker.tempHp);
		tempInputEl.min = "0";
		tempCtrlEl.appendChild(tempInputEl);
		tempInputEl.addEventListener("change", () => {
			tracker.tempHp = Math.max(0, Number(tempInputEl.value));
			updateDisplay();
		});

		const tempClearBtn = tempCtrlEl.createEl("button", { text: "Clear", cls: "dndbi-hpmodal-step-btn" });
		tempClearBtn.addEventListener("click", () => {
			tracker.tempHp = 0;
			tempInputEl.value = "0";
			updateDisplay();
		});

		// ── Max HP Setup ─────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Max HP" });

		const maxCtrlEl = contentEl.createEl("div", { cls: "dndbi-hpmodal-ctrl-row" });

		const maxInputEl = activeDocument.createElement("input");
		maxInputEl.className = "dndbi-hpmodal-number-input";
		maxInputEl.type = "number";
		maxInputEl.value = String(tracker.maxHp);
		maxInputEl.min = "1";
		maxCtrlEl.appendChild(maxInputEl);
		maxInputEl.addEventListener("change", () => {
			tracker.maxHp = Math.max(1, Number(maxInputEl.value));
			tracker.currentHp = Math.min(tracker.currentHp, tracker.maxHp);
			currentInputEl.value = String(tracker.currentHp);
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
	plugin: InstanceType<typeof Plugin> & {
		rollHistory: DiceRoll[];
	};
	filterDie: string | null = null;
	private historyEl!: HTMLElement;
	private statsEl!: HTMLElement;

	constructor(app: App, plugin: DiceRollerModal["plugin"]) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "🎲 Dice Roller" });

		// ── Die buttons ─────────────────────────────────────────────────────
		const dice: { label: string; sides: number }[] = [
			{ label: "d4",   sides: 4   },
			{ label: "d6",   sides: 6   },
			{ label: "d8",   sides: 8   },
			{ label: "d10",  sides: 10  },
			{ label: "d12",  sides: 12  },
			{ label: "d20",  sides: 20  },
			{ label: "d100", sides: 100 },
		];

		const btnGrid = contentEl.createEl("div", { cls: "dndbi-dice-btn-grid" });

		// ── Result display ───────────────────────────────────────────────────
		const resultEl = contentEl.createEl("div", { cls: "dndbi-dice-result" });
		resultEl.setText("—");

		const subtitleEl = contentEl.createEl("div", { cls: "dndbi-dice-subtitle" });

		for (const die of dice) {
			const btn = btnGrid.createEl("button", {
				text: die.label,
				cls: "mod-cta dndbi-dice-btn",
			});
			btn.addEventListener("click", () => {
				const roll = Math.floor(Math.random() * die.sides) + 1;
				const now = new Date();
				const timestamp = now.toLocaleString();

				this.plugin.rollHistory.unshift({
					die: die.label,
					result: roll,
					modifier: 0,
					label: die.label,
					timestamp,
				});
				if (this.plugin.rollHistory.length > 50)
					this.plugin.rollHistory.length = 50;

				resultEl.setText(`${roll}`);
				subtitleEl.setText(`${die.label} rolled at ${timestamp}`);

				new Notice(`🎲 ${die.label}: ${roll}`, 4000);

				this.renderHistory();
			});
		}

		// ── History ──────────────────────────────────────────────────────────
		contentEl.createEl("h3", { text: "Roll History" });

		// ── History controls (filter, export, stats) ────────────────────────
		const controlsEl = contentEl.createEl("div", { cls: "dndbi-dice-controls" });

		const filterLabel = controlsEl.createEl("label", { cls: "dndbi-dice-filter-label" });
		filterLabel.setText("Filter:");
		const filterSelect = filterLabel.createEl("select", { cls: "dndbi-dice-filter-select" });
		filterSelect.add(new Option("All dice", ""));
		for (const die of dice) {
			filterSelect.add(new Option(die.label, die.label));
		}
		filterSelect.addEventListener("change", () => {
			this.filterDie = filterSelect.value || null;
			this.renderHistory();
		});

		const exportBtn = controlsEl.createEl("button", { text: "Export CSV", cls: "dndbi-dice-ctrl-btn" });
		exportBtn.addEventListener("click", () => this.exportHistoryCSV());

		const copyBtn = controlsEl.createEl("button", { text: "Copy History", cls: "dndbi-dice-ctrl-btn" });
		copyBtn.addEventListener("click", () => {
			this.copyHistoryToClipboard().catch((err: unknown) => {
				console.error("Copy failed:", err);
			});
		});

		// ── History display ─────────────────────────────────────────────────
		this.historyEl = contentEl.createEl("div", { cls: "dndbi-dice-history" });

		// ── Statistics section ───────────────────────────────────────────────
		this.statsEl = contentEl.createEl("div", { cls: "dndbi-dice-stats" });

		const clearBtn = contentEl.createEl("button", { text: "Clear History", cls: "dndbi-dice-clear-btn" });
		clearBtn.addEventListener("click", () => {
			this.plugin.rollHistory = [];
			this.renderHistory();
		});

		this.renderHistory();
	}

	getFilteredHistory(): DiceRoll[] {
		if (!this.filterDie) return this.plugin.rollHistory;
		return this.plugin.rollHistory.filter((r: DiceRoll) => r.die === this.filterDie);
	}

	renderHistory() {
		const filtered = this.getFilteredHistory();

		this.historyEl.empty();
		if (filtered.length === 0) {
			this.historyEl.createEl("div", {
				text: "No rolls yet.",
				cls: "dndbi-dice-history-empty",
			});
		} else {
			for (const entry of filtered) {
				const row = this.historyEl.createEl("div", { cls: "dndbi-dice-history-row" });
				const entryModStr = entry.modifier >= 0 ? `+${entry.modifier}` : `${entry.modifier}`;
				const entryTotal = entry.result + entry.modifier;
				row.createEl("span", {
					text: `🎲 ${entry.label}: ${entry.die}(${entry.result})${entry.modifier !== 0 ? entryModStr : ""} = ${entryTotal}`,
				});
				row.createEl("span", {
					text: entry.timestamp,
					cls: "dndbi-dice-history-ts",
				});
			}
		}

		this.updateStats(filtered, this.statsEl);
	}

	updateStats(filtered: DiceRoll[], statsEl: HTMLElement) {
		if (filtered.length === 0) {
			statsEl.setText("");
			return;
		}

		const results = filtered.map((r: DiceRoll) => r.result);
		const avg = (results.reduce((a: number, b: number) => a + b, 0) / results.length).toFixed(2);
		const max = Math.max(...results);
		const min = Math.min(...results);
		const nat20s = results.filter((r: number) => r === 20).length;
		const nat1s  = results.filter((r: number) => r === 1).length;

		const freq: Record<number, number> = {};
		results.forEach((r: number) => {
			freq[r] = (freq[r] ?? 0) + 1;
		});
		const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
		const modeStr = mode ? `${mode[0]} (${mode[1]}×)` : "—";

		let statsText = `Avg: ${avg} | Max: ${max} | Min: ${min} | Mode: ${modeStr}`;
		if (nat20s > 0) statsText += ` | 🎉 ${nat20s}×`;
		if (nat1s  > 0) statsText += ` | 💀 ${nat1s}×`;

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
		const url  = URL.createObjectURL(blob);
		const a    = activeDocument.createElement("a");
		a.href     = url;
		a.download = `roll-history-${new Date().toISOString().split("T")[0]}.csv`;
		a.click();
		URL.revokeObjectURL(url);
		new Notice("History exported as CSV.", 2000);
	}

	async copyHistoryToClipboard() {
		const filtered = this.getFilteredHistory();
		if (filtered.length === 0) {
			new Notice("No rolls to copy.", 2000);
			return;
		}

		let text = "Roll History:\n";
		for (const entry of filtered) {
			const modStr = entry.modifier >= 0 ? `+${entry.modifier}` : `${entry.modifier}`;
			const total  = entry.result + entry.modifier;
			text += `${entry.die}(${entry.result})${entry.modifier !== 0 ? modStr : ""} = ${total} [${entry.timestamp}]\n`;
		}

		await navigator.clipboard.writeText(text);
		new Notice("History copied to clipboard.", 2000);
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
	const urls: Record<string, string> = {
		spells:       `${clean}/data/spells/spells-phb.json`,
		items:        `${clean}/data/items.json`,
		classfeature: `${clean}/data/classfeature.json`,
		races:        `${clean}/data/races.json`,
	};
	try {
		const resp = await requestUrl({ url: urls[type], headers: { Accept: "application/json" } });
		if (resp.status < 200 || resp.status >= 300) return null;
		const json = resp.json as Record<string, unknown>;
		const keyMap: Record<string, string> = {
			spells:       "spell",
			items:        "item",
			classfeature: "classFeature",
			races:        "race",
		};
		const raw = json[keyMap[type]];
		if (!Array.isArray(raw)) return null;
		const arr = raw as Array<Record<string, unknown>>;
		const lower = name.toLowerCase();
		return arr.find((e) => typeof e["name"] === "string" && e["name"].toLowerCase() === lower) ?? null;
	} catch {
		return null;
	}
}

function render5eDescription(entry: Record<string, unknown>): string {
	const entries = entry["entries"];
	if (!Array.isArray(entries)) {
		return typeof entry["desc"] === "string" ? entry["desc"] : "";
	}
	return (entries as Array<unknown>).map((e) => {
		if (typeof e === "string") return e;
		if (typeof e !== "object" || e === null) return JSON.stringify(e);
		const obj = e as Record<string, unknown>;
		if (obj["type"] === "entries") {
			const subEntries = Array.isArray(obj["entries"])
				? (obj["entries"] as string[]).join("\n")
				: "";
			const subName = typeof obj["name"] === "string" ? obj["name"] : "";
			return `**${subName}**\n${subEntries}`;
		}
		if (obj["type"] === "list") {
			const items = Array.isArray(obj["items"]) ? (obj["items"] as string[]) : [];
			return items.map((i) => `• ${i}`).join("\n");
		}
		if (obj["type"] === "table") {
			const cols = Array.isArray(obj["colLabels"]) ? (obj["colLabels"] as string[]) : [];
			const rows = Array.isArray(obj["rows"])    ? (obj["rows"]    as string[][]) : [];
			return (
				`| ${cols.join(" | ")} |\n` +
				`|${cols.map(() => "---").join("|")}|\n` +
				rows.map((r) => `| ${r.join(" | ")} |`).join("\n")
			);
		}
		return JSON.stringify(e);
	}).join("\n\n");
}

// ─── Full Interactive Character Sheet Modal ────────────────────────────────────

class FullCharacterSheetModal extends Modal {
	plugin: InstanceType<typeof Plugin> & {
		rollHistory: DiceRoll[];
		pluginState: Map<string, string>;
		hpTracking: Map<string, { maxHp: number; currentHp: number; tempHp: number }>;
		pluginSettings: { fiveEtoolsEnabled: boolean; fiveEtoolsBaseUrl: string };
	};
	char: DdbCharacter;
	stats: Record<string, number>;
	pb: number;
	rollLog: Array<{ text: string; ts: string }> = [];

	constructor(
		app: App,
		plugin: FullCharacterSheetModal["plugin"],
		char: DdbCharacter,
		stats: Record<string, number>,
		pb: number,
	) {
		super(app);
		this.plugin = plugin;
		this.char   = char;
		this.stats  = stats;
		this.pb     = pb;
		this.modalEl.setCssStyles({
			width:     "min(900px, 95vw)",
			maxHeight: "92vh",
			overflowY: "auto",
		});
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
			const empty = this.rollLogEl.createEl("div", { text: "No rolls yet." });
			empty.addClass("dndbi-cs-roll-empty");
			return;
		}
		for (const entry of this.rollLog) {
			const row = this.rollLogEl.createEl("div");
			row.addClass("dndbi-cs-roll-row");
			row.createEl("span").setText(entry.text);
			const ts = row.createEl("span");
			ts.setText(entry.ts);
			ts.addClass("dndbi-cs-roll-ts");
		}
	}

	// ── HP state ─────────────────────────────────────────────────────────────

	private loadHP(): HPState {
		const key = `dnd-hp-${this.char.id}`;
		const conScore = this.stats["con"] ?? 10;
		const totalLevel = calcLevel(this.char.classes ?? []);
		const allMods = getAllModifiers(this.char);
		try {
			const raw = this.plugin.pluginState.get(key);
			if (raw) {
				const s = JSON.parse(raw) as HPState;
				const hp = calcHP(this.char, conScore, totalLevel, allMods);
				s.max = hp.max;
				return s;
			}
		} catch { /* */ }
		const hp = calcHP(this.char, conScore, totalLevel, allMods);
		return { max: hp.max, current: hp.current, temp: hp.temp, dsS: 0, dsF: 0, log: [] };
	}

	private saveHP(s: HPState): void {
		this.plugin.pluginState.set(`dnd-hp-${this.char.id}`, JSON.stringify(s));
	}

	// ── Section builders ─────────────────────────────────────────────────────

	private sectionEl(parent: HTMLElement, title: string): HTMLElement {
		const wrap = parent.createEl("div");
		wrap.addClass("dndbi-cs-section");
		const hdr = wrap.createEl("div");
		hdr.addClass("dndbi-cs-section-hdr");
		hdr.setText(title);
		return wrap;
	}

	private pill(parent: HTMLElement, label: string, value: string, sub?: string): void {
		const p = parent.createEl("div");
		p.addClass("dndbi-cs-pill");
		const lbl = p.createEl("div");
		lbl.setText(label);
		lbl.addClass("dndbi-cs-pill-label");
		const val = p.createEl("div");
		val.setText(value);
		val.addClass("dndbi-cs-pill-value");
		if (sub) {
			const s = p.createEl("div");
			s.setText(sub);
			s.addClass("dndbi-cs-pill-sub");
		}
	}

	private rollBtn(parent: HTMLElement, label: string, modifier: number): HTMLButtonElement {
		const btn = parent.createEl("button");
		btn.setText(`${this.modStr(modifier)}`);
		btn.addClass("dndbi-cs-roll-btn");
		btn.addEventListener("mouseenter", () => { btn.addClass("dndbi-cs-roll-btn--active"); });
		btn.addEventListener("mouseleave", () => { btn.removeClass("dndbi-cs-roll-btn--active"); });
		btn.addEventListener("click", () => this.rollD20(modifier, label));
		return btn;
	}

	// Always renders a badge — every roll has an explicit imported status
	// from D&D Beyond (advantage / none / disadvantage), not just the
	// advantage/disadvantage cases.
	private advBadge(parent: HTMLElement, advState: AdvState): HTMLElement {
		const badge = parent.createEl("span");
		const variant = advState === "advantage" ? "is-advantage" : advState === "disadvantage" ? "is-disadvantage" : "is-none";
		badge.setText(advState === "advantage" ? "▲A" : advState === "disadvantage" ? "▼D" : "–N");
		badge.addClass("dndbi-cs-adv-badge", variant);
		badge.setAttr("title", advState === "advantage" ? "Advantage" : advState === "disadvantage" ? "Disadvantage" : "No advantage/disadvantage");
		return badge;
	}

	// ── onOpen ───────────────────────────────────────────────────────────────

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("dndbi-cs-content");

		const char = this.char;
		const stats = this.stats;
		const pb = this.pb;

		const classes: DdbClass[] = char.classes ?? [];
		const totalLevel = calcLevel(classes);
		const classString = classes.map((c) => `${c.definition?.name ?? "?"} ${c.level ?? 0}`).join(" / ");
		const raceName = char.race?.fullName ?? char.race?.baseName ?? "Unknown";
		const sheetAllMods = getAllModifiers(char);
		const sheetStatsById: Record<number, number> = { 1: stats.str, 2: stats.dex, 3: stats.con, 4: stats.int, 5: stats.wis, 6: stats.cha };
		const ac = calcAC(char, stats.dex, sheetStatsById, sheetAllMods);
		const speed = char.race?.weightSpeeds?.normal?.walk ?? 30;
		const initMod = this.mod(stats.dex);
		const hpState = this.loadHP();

		const allMods = getAllModifiers(char);

		// ── Layout: two columns on wide, single on narrow ────────────────────
		const root = contentEl.createEl("div");
		root.addClass("dndbi-cs-root");

		const mainCol = root.createEl("div");
		mainCol.addClass("dndbi-cs-main-col");

		const sideCol = root.createEl("div");
		sideCol.addClass("dndbi-cs-side-col");

		// ════════════════════════════════════════════════════════════════════
		// HEADER
		// ════════════════════════════════════════════════════════════════════
		const header = mainCol.createEl("div");
		header.addClass("dndbi-cs-header");

		if (char.avatarUrl) {
			const avatar = header.createEl("img");
			avatar.src = char.avatarUrl;
			avatar.addClass("dndbi-cs-avatar");
		}

		const headerText = header.createEl("div");
		const nameEl = headerText.createEl("div");
		nameEl.setText(char.name ?? "Unknown");
		nameEl.addClass("dndbi-cs-char-name");
		const subEl = headerText.createEl("div");
		subEl.setText(`${classString} • ${raceName} • Level ${totalLevel}`);
		subEl.addClass("dndbi-cs-char-sub");

		const closeBtn = header.createEl("button");
		closeBtn.setText("✕ Close");
		closeBtn.addClass("dndbi-cs-close-btn");
		closeBtn.addEventListener("click", () => this.close());

		// ════════════════════════════════════════════════════════════════════
		// CORE STATS ROW
		// ════════════════════════════════════════════════════════════════════
		const coreSection = this.sectionEl(mainCol, "Core Stats");
		const coreRow = coreSection.createEl("div");
		coreRow.addClass("dndbi-cs-core-row");
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
		hpWrap.addClass("dndbi-cs-hp-wrap");

		// HP bar
		const barWrap = hpWrap.createEl("div");
		barWrap.addClass("dndbi-cs-bar-wrap");
		const barFill = barWrap.createEl("div");
		barFill.addClass("dndbi-cs-bar-fill");
		const barLbl = barWrap.createEl("div");
		barLbl.addClass("dndbi-cs-bar-lbl");

		let hpSt = { ...hpState };

		const dsSPips: HTMLElement[] = [];
		const dsFPips: HTMLElement[] = [];

		const renderHP = () => {
			const pct = Math.max(0, Math.min(100, (hpSt.current / hpSt.max) * 100));
			// Width is data-driven so we must set it inline; colour uses CSS classes.
			barFill.setCssStyles({ width: `${pct}%` });
			barFill.removeClass("dndbi-cs-bar-fill--high", "dndbi-cs-bar-fill--mid", "dndbi-cs-bar-fill--low");
			barFill.addClass(pct > 50 ? "dndbi-cs-bar-fill--high" : pct > 25 ? "dndbi-cs-bar-fill--mid" : "dndbi-cs-bar-fill--low");
			barLbl.setText(`${hpSt.current} / ${hpSt.max} HP${hpSt.temp > 0 ? ` (+${hpSt.temp} temp)` : ""}`);
			// refresh core stat pill
			const hpPillVal = coreRow.querySelector<HTMLElement>(".dndbi-cs-pill-value");
			if (hpPillVal) hpPillVal.setText(`${hpSt.current}/${hpSt.max}`);
			// update death save pips
			dsSPips.forEach((p, i) => { p.toggleClass("is-filled", i < hpSt.dsS); });
			dsFPips.forEach((p, i) => { p.toggleClass("is-filled", i < hpSt.dsF); });
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
		dmgRow.addClass("dndbi-cs-dmg-row");
		const amtInput = dmgRow.createEl("input");
		amtInput.type = "number"; amtInput.min = "0"; amtInput.value = "1";
		amtInput.addClass("dndbi-cs-amt-input");
		const getAmt = () => Math.max(0, parseInt(amtInput.value, 10) || 0);

		const dmgBtn = dmgRow.createEl("button");
		dmgBtn.setText("⚔️ Damage");
		dmgBtn.addClass("dndbi-cs-dmg-btn");
		dmgBtn.addEventListener("click", () => {
			const n = getAmt(); const fromT = Math.min(hpSt.temp, n);
			hpSt.temp = hpSt.temp - fromT; hpSt.current = Math.max(0, hpSt.current - (n - fromT));
			addHPLog(`⚔️ −${n} dmg → ${hpSt.current} HP`); renderHP();
		});

		const healBtn = dmgRow.createEl("button");
		healBtn.setText("💚 Heal");
		healBtn.addClass("dndbi-cs-heal-btn");
		healBtn.addEventListener("click", () => {
			const n = getAmt(); hpSt.current = Math.min(hpSt.max, hpSt.current + n);
			addHPLog(`💚 +${n} heal → ${hpSt.current} HP`); renderHP();
		});

		// quick buttons
		const quickRow = hpWrap.createEl("div");
		quickRow.addClass("dndbi-cs-quick-row");
		const qBtn = (lbl: string, d: number) => {
			const b = quickRow.createEl("button"); b.setText(lbl);
			b.addClass("dndbi-cs-quick-btn");
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
		tmpRow.addClass("dndbi-cs-tmp-row");
		const tmpLbl = tmpRow.createEl("span"); tmpLbl.setText("Temp HP:"); tmpLbl.addClass("dndbi-cs-tmp-lbl");
		const tmpInput = tmpRow.createEl("input");
		tmpInput.type = "number"; tmpInput.min = "0"; tmpInput.value = String(hpSt.temp);
		tmpInput.addClass("dndbi-cs-tmp-input");
		const setTmpBtn = tmpRow.createEl("button"); setTmpBtn.setText("Set");
		setTmpBtn.addClass("dndbi-cs-tmp-set-btn");
		setTmpBtn.addEventListener("click", () => { hpSt.temp = Math.max(0, parseInt(tmpInput.value,10)||0); addHPLog(`💙 Temp HP set to ${hpSt.temp}`); renderHP(); });
		const clrTmpBtn = tmpRow.createEl("button"); clrTmpBtn.setText("Clear");
		clrTmpBtn.addClass("dndbi-cs-tmp-clr-btn");
		clrTmpBtn.addEventListener("click", () => { hpSt.temp=0; tmpInput.value="0"; addHPLog("💙 Temp HP cleared"); renderHP(); });

		// death saves
		const dsSect = hpWrap.createEl("div");
		dsSect.addClass("dndbi-cs-ds-sect");

		const makePips = (
			colorClass: "is-success" | "is-failure",
			pips: HTMLElement[],
			get: () => number,
			set: (n: number) => void,
		) => {
			const grp = dsSect.createEl("div"); grp.addClass("dndbi-cs-ds-grp");
			for (let i = 1; i <= 3; i++) {
				const p = grp.createEl("button");
				const pipIndex = i;
				p.addClass("dndbi-cs-ds-pip", colorClass);
				p.addEventListener("click", () => { set(get() >= pipIndex ? pipIndex - 1 : pipIndex); renderHP(); });
				pips.push(p);
			}
		};
		makePips("is-success", dsSPips, () => hpSt.dsS, (n) => { hpSt.dsS=n; });
		makePips("is-failure", dsFPips, () => hpSt.dsF, (n) => { hpSt.dsF=n; });
		const dsRstBtn = dsSect.createEl("button"); dsRstBtn.setText("Reset Saves");
		dsRstBtn.addClass("dndbi-cs-ds-rst-btn");
		dsRstBtn.addEventListener("click", () => { hpSt.dsS=0; hpSt.dsF=0; addHPLog("🔄 Death saves reset"); renderHP(); });

		renderHP();

		// ════════════════════════════════════════════════════════════════════
		// ABILITY SCORES
		// ════════════════════════════════════════════════════════════════════
		const abilSection = this.sectionEl(mainCol, "Ability Scores");
		const abilGrid = abilSection.createEl("div");
		abilGrid.addClass("dndbi-cs-abil-grid");

		const abilDefs: Array<{ key: keyof typeof stats; label: string }> = [
			{ key: "str", label: "STR" }, { key: "dex", label: "DEX" },
			{ key: "con", label: "CON" }, { key: "int", label: "INT" },
			{ key: "wis", label: "WIS" }, { key: "cha", label: "CHA" },
		];

		for (const { key, label } of abilDefs) {
			const score = stats[key];
			const modNum = this.mod(score);
			const card = abilGrid.createEl("div");
			card.addClass("dndbi-cs-abil-card");
			card.addEventListener("mouseenter", () => { card.addClass("dndbi-cs-abil-card--hover"); });
			card.addEventListener("mouseleave", () => { card.removeClass("dndbi-cs-abil-card--hover"); });
			card.addEventListener("click", () => this.rollD20(modNum, `${label} Check`));
			const lbl = card.createEl("div"); lbl.setText(label); lbl.addClass("dndbi-cs-abil-lbl");
			const scoreEl = card.createEl("div"); scoreEl.setText(String(score)); scoreEl.addClass("dndbi-cs-abil-score");
			const modEl = card.createEl("div"); modEl.setText(this.modStr(modNum)); modEl.addClass("dndbi-cs-abil-mod");
			const hint = card.createEl("div"); hint.setText("click to roll"); hint.addClass("dndbi-cs-abil-hint");
		}

		// ════════════════════════════════════════════════════════════════════
		// SAVING THROWS
		// ════════════════════════════════════════════════════════════════════
		const saveSection = this.sectionEl(mainCol, "Saving Throws");
		const saveGrid = saveSection.createEl("div");
		saveGrid.addClass("dndbi-cs-save-grid");

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
			row.addClass("dndbi-cs-save-row");
			const left = row.createEl("div"); left.addClass("dndbi-cs-save-left");
			const dot = left.createEl("span");
			dot.setText(isProficient ? "●" : "○");
			dot.addClass(isProficient ? "dndbi-cs-dot--prof" : "dndbi-cs-dot--none");
			const _lbl = left.createEl("span"); _lbl.setText(label); _lbl.addClass("dndbi-cs-save-lbl");
			const advState = getAdvantageState(allMods, subType, "saving-throws");
			this.advBadge(left, advState);
			this.rollBtn(row, `${label} Save`, modNum);
		}

		// ════════════════════════════════════════════════════════════════════
		// SKILLS
		// ════════════════════════════════════════════════════════════════════
		const skillSection = this.sectionEl(mainCol, "Skills");
		const skillGrid = skillSection.createEl("div");
		skillGrid.addClass("dndbi-cs-skill-grid");

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
			row.addClass("dndbi-cs-skill-row");
			const left = row.createEl("div"); left.addClass("dndbi-cs-save-left");
			const dot = left.createEl("span");
			dot.setText(isExpertise ? "★" : isProficient ? "●" : "○");
			dot.addClass(isExpertise ? "dndbi-cs-dot--expert" : isProficient ? "dndbi-cs-dot--prof" : "dndbi-cs-dot--none");
			const _lbl = left.createEl("span"); _lbl.setText(label); _lbl.addClass("dndbi-cs-skill-lbl");
			const advState = getAdvantageState(allMods, subType, "ability-checks");
			this.advBadge(left, advState);
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
				row.addClass("dndbi-cs-action-row");
				const nameEl = row.createEl("span");
				nameEl.setText(`${action.isSpell ? "✨" : "⚔️"} ${action.name}`);
				nameEl.addClass("dndbi-cs-action-name");
				if (action.notes) {
					const notesEl = row.createEl("span"); notesEl.setText(action.notes);
					notesEl.addClass("dndbi-cs-action-notes");
				}
				if (action.attackBonus != null) {
					const atkBtn = row.createEl("button");
					atkBtn.setText(`🎲 ATK ${this.modStr(action.attackBonus)}`);
					atkBtn.addClass("dndbi-cs-atk-btn");
					atkBtn.addEventListener("click", () => this.rollD20(action.attackBonus!, `${action.name} Attack`));
				}
				const hasDmg = action.damageDice != null || action.damageBonus !== 0;
				if (hasDmg) {
					const dmgStr = action.damageDice
						? `${action.damageDice}${action.damageBonus !== 0 ? this.modStr(action.damageBonus) : ""}`
						: `${action.damageBonus}`;
					const dmgBtnEl = row.createEl("button");
					dmgBtnEl.setText(`🎲 DMG ${dmgStr}`);
					dmgBtnEl.addClass("dndbi-cs-dmg-action-btn");
					dmgBtnEl.addEventListener("click", () => this.rollDamage(action.damageDice, action.damageBonus, action.name));

					// 5etools weapon lookup
					if (this.plugin.pluginSettings.fiveEtoolsEnabled) {
						const infoBtn = row.createEl("button"); infoBtn.setText("📖");
						infoBtn.title = "Fetch from 5etools";
						infoBtn.addClass("dndbi-cs-info-btn");
						infoBtn.addEventListener("click", () => {
							void (async () => {
								infoBtn.setText("⏳"); infoBtn.disabled = true;
								const entry = await fetch5eData(this.plugin.pluginSettings.fiveEtoolsBaseUrl, "items", action.name);
								infoBtn.setText("📖"); infoBtn.disabled = false;
								if (!entry) { new Notice(`No 5etools entry found for "${action.name}"`, 2000); return; }
								new FiveEDataModal(this.app, action.name, render5eDescription(entry)).open();
							})();
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
					try {
						const raw = this.plugin.pluginState.get(slotKey) ?? "null";
						const parsed: unknown = JSON.parse(raw);
						if (parsed !== null && typeof parsed === "object") {
							return parsed as Record<number, number>;
						}
						return {};
					} catch { return {}; }
				};
				const saveSlots = (d: Record<number, number>) => this.plugin.pluginState.set(slotKey, JSON.stringify(d));
				let usedSlots: Record<number, number> = loadSlots();

				for (const slot of usefulSlots) {
					const lvl = slot.level ?? 0;
					const maxPips = slot.max ?? 0;
					const slotRow = slotSection.createEl("div");
					slotRow.addClass("dndbi-cs-slot-row");
					const lvlLbl = slotRow.createEl("span"); lvlLbl.setText(`Level ${lvl}`);
					lvlLbl.addClass("dndbi-cs-slot-lbl");
					const pipsEl = slotRow.createEl("div"); pipsEl.addClass("dndbi-cs-slot-pips");
					const restBtn = slotRow.createEl("button"); restBtn.setText("Rest");
					restBtn.addClass("dndbi-cs-slot-rest-btn");

					const renderPips = () => {
						pipsEl.empty();
						const used = usedSlots[lvl] ?? 0;
						for (let i = 0; i < maxPips; i++) {
							const pip = pipsEl.createEl("button");
							const isUsed = i < used;
							pip.addClass("dndbi-cs-spell-pip");
							if (isUsed) { pip.addClass("dndbi-cs-spell-pip--used"); } else { pip.removeClass("dndbi-cs-spell-pip--used"); }
							pip.addEventListener("click", () => {
								const cur = usedSlots[lvl] ?? 0;
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
				lvlHdr.addClass("dndbi-cs-spell-lvl-hdr");
				for (const spell of spells) {
					const def = spell.definition; if (!def) continue;
					const sRow = spellSection.createEl("div");
					sRow.addClass("dndbi-cs-spell-row");
					sRow.addEventListener("mouseenter", () => { sRow.addClass("dndbi-cs-spell-row--hover"); });
					sRow.addEventListener("mouseleave", () => { sRow.removeClass("dndbi-cs-spell-row--hover"); });

					const prepDot = sRow.createEl("span"); prepDot.setText(spell.prepared ? "●" : "○");
					prepDot.addClass(spell.prepared ? "dndbi-cs-dot--prof" : "dndbi-cs-dot--none");
					prepDot.addClass("dndbi-cs-spell-prep-dot");
					const spellName = sRow.createEl("span"); spellName.setText(def.name ?? "Unknown");
					spellName.addClass("dndbi-cs-spell-name");
					const school = sRow.createEl("span"); school.setText(def.school ?? "");
					school.addClass("dndbi-cs-spell-school");
					if (def.concentration) {
						const conc = sRow.createEl("span"); conc.setText("C");
						conc.addClass("dndbi-cs-spell-conc");
					}

					const descEl = spellSection.createEl("div");
					descEl.addClass("dndbi-cs-spell-desc");
					let expanded = false;
					let fetched = false;

					sRow.addEventListener("click", () => {
						void (async () => {
							expanded = !expanded;
							if (expanded) { descEl.addClass("dndbi-cs-spell-desc--open"); } else { descEl.removeClass("dndbi-cs-spell-desc--open"); }
							if (expanded && !fetched) {
								fetched = true;
								if (def.description) {
									descEl.setText(stripHtml(def.description));
								} else if (this.plugin.pluginSettings.fiveEtoolsEnabled) {
									descEl.setText("⏳ Fetching from 5etools…");
									const entry = await fetch5eData(this.plugin.pluginSettings.fiveEtoolsBaseUrl, "spells", def.name ?? "");
									descEl.setText(entry ? render5eDescription(entry) : "No description available.");
								} else {
									descEl.setText("No description available. Enable 5etools integration in settings to fetch spell descriptions.");
								}
							}
						})();
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
			const loadEq = (): Record<string, boolean> => {
				try {
					const raw = this.plugin.pluginState.get(eqKey) ?? "null";
					const parsed: unknown = JSON.parse(raw);
					if (parsed !== null && typeof parsed === "object") {
						return parsed as Record<string, boolean>;
					}
					return {};
				} catch { return {}; }
			};
			const saveEq = (d: Record<string, boolean>) => this.plugin.pluginState.set(eqKey, JSON.stringify(d));
			let eqState: Record<string, boolean> = loadEq();

			for (const item of inventory) {
				const def = item.definition; if (!def) continue;
				const itemKey = (def.name ?? "unknown").toLowerCase().replace(/\s+/g, "-");
				if (!(itemKey in eqState)) eqState[itemKey] = item.equipped ?? false;

				const iRow = eqSection.createEl("div");
				iRow.addClass("dndbi-cs-eq-row");
				const toggle = iRow.createEl("button");
				const renderToggle = () => {
					toggle.setText(eqState[itemKey] ? "⚔️" : "🎒");
					toggle.title = eqState[itemKey] ? "Equipped — click to unequip" : "Unequipped — click to equip";
					if (!eqState[itemKey]) { iRow.addClass("dndbi-cs-eq-row--unequipped"); } else { iRow.removeClass("dndbi-cs-eq-row--unequipped"); }
				};
				toggle.addClass("dndbi-cs-eq-toggle");
				toggle.addEventListener("click", () => { eqState[itemKey] = !eqState[itemKey]; saveEq(eqState); renderToggle(); });
				renderToggle();

				const itemName = iRow.createEl("span"); itemName.setText(def.name ?? "Unknown");
				itemName.addClass("dndbi-cs-eq-name");
				const qty = iRow.createEl("span"); qty.setText(`×${item.quantity ?? 1}`);
				qty.addClass("dndbi-cs-eq-qty");
				if (def.weight) {
					const wt = iRow.createEl("span"); wt.setText(`${def.weight} lb`);
					wt.addClass("dndbi-cs-eq-wt");
				}

				// 5etools item lookup
				if (this.plugin.pluginSettings.fiveEtoolsEnabled) {
					const infoBtn = iRow.createEl("button"); infoBtn.setText("📖"); infoBtn.title = "Fetch from 5etools";
					infoBtn.addClass("dndbi-cs-info-btn");
					infoBtn.addEventListener("click", () => {
						void (async () => {
							infoBtn.setText("⏳"); infoBtn.disabled = true;
							const entry = await fetch5eData(this.plugin.pluginSettings.fiveEtoolsBaseUrl, "items", def.name ?? "");
							infoBtn.setText("📖"); infoBtn.disabled = false;
							if (!entry) { new Notice(`No 5etools entry for "${def.name}"`, 2000); return; }
							new FiveEDataModal(this.app, def.name ?? "Item", render5eDescription(entry)).open();
						})();
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
				card.addClass("dndbi-cs-feat-card");
				const hdr = card.createEl("div");
				hdr.addClass("dndbi-cs-feat-hdr");
				const hdrSpan = hdr.createEl("span"); hdrSpan.setText(name); hdrSpan.addClass("dndbi-cs-feat-hdr-name");
				const chevron = hdr.createEl("span"); chevron.setText("▶"); chevron.addClass("dndbi-cs-feat-chevron");

				const body = card.createEl("div");
				body.addClass("dndbi-cs-feat-body");

				let expanded = false; let fetched = false;

				hdr.addEventListener("click", () => {
					void (async () => {
						expanded = !expanded;
						if (expanded) { body.addClass("dndbi-cs-feat-body--open"); } else { body.removeClass("dndbi-cs-feat-body--open"); }
						if (expanded) { chevron.addClass("dndbi-cs-feat-chevron--open"); } else { chevron.removeClass("dndbi-cs-feat-chevron--open"); }
						if (expanded && !fetched) {
							fetched = true;
							if (rawDesc) {
								body.setText(stripHtml(rawDesc));
							} else if (this.plugin.pluginSettings.fiveEtoolsEnabled) {
								body.setText("⏳ Fetching from 5etools…");
								const entry = await fetch5eData(this.plugin.pluginSettings.fiveEtoolsBaseUrl, fetchType, name);
								body.setText(entry ? render5eDescription(entry) : "No description available.");
							} else {
								body.setText("Enable 5etools integration in settings to fetch descriptions.");
							}
						}
					})();
				});

				if (this.plugin.pluginSettings.fiveEtoolsEnabled) {
					const fetchBtn = hdr.createEl("button"); fetchBtn.setText("📖"); fetchBtn.title = "Refresh from 5etools";
					fetchBtn.addClass("dndbi-cs-feat-fetch-btn");
					fetchBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						void (async () => {
							fetchBtn.setText("⏳"); fetchBtn.disabled = true;
							const entry = await fetch5eData(this.plugin.pluginSettings.fiveEtoolsBaseUrl, fetchType, name);
							fetchBtn.setText("📖"); fetchBtn.disabled = false;
							body.setText(entry ? render5eDescription(entry) : "No entry found.");
							body.addClass("dndbi-cs-feat-body--open");
							expanded = true;
							chevron.addClass("dndbi-cs-feat-chevron--open");
						})();
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
			clsHdr.addClass("dndbi-cs-cls-hdr");
		}

		// ════════════════════════════════════════════════════════════════════
		// SESSION NOTES (editable, persisted)
		// ════════════════════════════════════════════════════════════════════
		const notesSection = this.sectionEl(mainCol, "Session Notes");
		const notesKey = `dnd-notes-${char.id}`;
		const notesArea = notesSection.createEl("textarea");
		notesArea.value = this.plugin.pluginState.get(notesKey) ?? "";
		notesArea.placeholder = "Add your session notes here…";
		notesArea.addClass("dndbi-cs-notes-area");
		notesArea.addEventListener("input", () => this.plugin.pluginState.set(notesKey, notesArea.value));

		// ════════════════════════════════════════════════════════════════════
		// SIDEBAR: Roll Log + Currency + Proficiencies
		// ════════════════════════════════════════════════════════════════════
		const rollSection = this.sectionEl(sideCol, "Roll Log");
		const clearRollBtn = rollSection.createEl("button"); clearRollBtn.setText("Clear");
		clearRollBtn.addClass("dndbi-cs-roll-clr-btn");
		clearRollBtn.addEventListener("click", () => { this.rollLog = []; this.refreshRollLog(); });
		const rollLogContainer = rollSection.createEl("div");
		rollLogContainer.addClass("dndbi-cs-roll-log");
		this.rollLogEl = rollLogContainer;
		this.refreshRollLog();

		// Currency
		const curr = char.currencies;
		if (curr) {
			const currSection = this.sectionEl(sideCol, "Currency");
			const currRow = currSection.createEl("div"); currRow.addClass("dndbi-cs-curr-row");
			const coin = (lbl: string, val: number, colorClass: string) => {
				const c = currRow.createEl("div");
					c.addClass("dndbi-cs-coin");
					c.addClass(colorClass);
				const cv = c.createEl("span"); cv.setText(String(val)); cv.addClass("dndbi-cs-coin-val");
				const cl = c.createEl("span"); cl.setText(lbl); cl.addClass("dndbi-cs-coin-lbl");
			};
			coin("CP", curr.cp ?? 0, "dndbi-cs-coin--cp");
			coin("SP", curr.sp ?? 0, "dndbi-cs-coin--sp");
			coin("EP", curr.ep ?? 0, "dndbi-cs-coin--ep");
			coin("GP", curr.gp ?? 0, "dndbi-cs-coin--gp");
			coin("PP", curr.pp ?? 0, "dndbi-cs-coin--pp");
		}

		// Proficiencies & Languages
		const profSection = this.sectionEl(sideCol, "Proficiencies & Languages");
		const profNames = allMods
			.filter((m) => m.type === "proficiency" && m.friendlySubtypeName)
			.map((m) => m.friendlySubtypeName ?? "")
			.filter((v, i, a) => v && a.indexOf(v) === i);
		if (profNames.length) {
			const profList = profSection.createEl("div"); profList.addClass("dndbi-cs-prof-list");
			profNames.forEach((p) => {
				const chip = profList.createEl("span"); chip.setText(p);
				chip.addClass("dndbi-cs-prof-chip");
			});
		}

		// 5etools status badge
		if (this.plugin.pluginSettings.fiveEtoolsEnabled) {
			const badge = sideCol.createEl("div");
			badge.addClass("dndbi-cs-5e-badge");
			badge.setText(`📖 5etools: ${this.plugin.pluginSettings.fiveEtoolsBaseUrl}`);
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
		const pre = this.contentEl.createEl("div", { cls: "dndbi-5e-modal-content" });
		pre.setText(this.content);
	}
	onClose(): void { this.contentEl.empty(); }
}


// ─── Settings Tab ─────────────────────────────────────────────────────────────

class DnDBeyondSettingTab extends PluginSettingTab {
	plugin: InstanceType<typeof Plugin> & {
		pluginSettings: {
			outputFolder: string;
			includeSpells: boolean;
			includeEquipment: boolean;
			includeFeatures: boolean;
			includeBackstory: boolean;
			fiveEtoolsEnabled: boolean;
			fiveEtoolsBaseUrl: string;
		};
		saveSettings: () => Promise<void>;
	};

	constructor(app: App, plugin: DnDBeyondSettingTab["plugin"]) {
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
					.setValue(this.plugin.pluginSettings.outputFolder)
					.onChange((value) => {
						this.plugin.pluginSettings.outputFolder = value;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include spells")
			.setDesc("Import the full spell list and spell slots.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.pluginSettings.includeSpells)
					.onChange((value) => {
						this.plugin.pluginSettings.includeSpells = value;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include equipment")
			.setDesc("Import the inventory / equipment table.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.pluginSettings.includeEquipment)
					.onChange((value) => {
						this.plugin.pluginSettings.includeEquipment = value;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include features & traits")
			.setDesc("Import racial traits, feats and character personality traits.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.pluginSettings.includeFeatures)
					.onChange((value) => {
						this.plugin.pluginSettings.includeFeatures = value;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include backstory & notes")
			.setDesc("Import character backstory and campaign notes from D&D Beyond.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.pluginSettings.includeBackstory)
					.onChange((value) => {
						this.plugin.pluginSettings.includeBackstory = value;
						void this.plugin.saveSettings();
					})
			);

		// ── 5etools integration ─────────────────────────────────────────────────
		new Setting(containerEl)
			.setName("Enable 5etools integration")
			.setDesc("Fetch rich descriptions for spells, items, class features, and racial traits from your self-hosted 5etools instance. Disabled by default.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.pluginSettings.fiveEtoolsEnabled)
					.onChange((value) => {
						this.plugin.pluginSettings.fiveEtoolsEnabled = value;
						void this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("5etools base URL")
			.setDesc("Base URL of your self-hosted 5etools instance (e.g. https://5e.tools or http://localhost:5000). Only used when the integration is enabled.")
			.addText((text) =>
				text
					.setPlaceholder("https://5e.tools")
					.setValue(this.plugin.pluginSettings.fiveEtoolsBaseUrl)
					.onChange((value) => {
						this.plugin.pluginSettings.fiveEtoolsBaseUrl = value.trim();
						void this.plugin.saveSettings();
					})
			);
	}
}

// ─── Main Plugin ────────────────────────────────────────────────────────────
// This is the plugin's entry point. Obsidian instantiates this class (it must
// extend Plugin and be the default export) and calls onload() on startup.
//
// NOTE: the property is named `pluginSettings`, not `settings` — a class member
// literally named `settings` on a Plugin subclass collides (by name only) with an
// unrelated member on a newer Obsidian API surface, which trips up
// eslint-plugin-obsidianmd's no-unsupported-api rule even though this code never
// touches that API. Renaming sidesteps the false positive; functionality is
// unchanged. Every `this.plugin.settings` reference in the modal classes above
// was updated to `this.plugin.pluginSettings` to match.
export default class DnDBeyondImporterPlugin extends Plugin {
	pluginSettings!: DnDBeyondImporterSettings;
	charCache: Map<string, { char: DdbCharacter; stats: Record<string, number>; pb: number }> = new Map();
	hpTracking: Map<string, { maxHp: number; currentHp: number; tempHp: number }> = new Map();
	// Backs the HP tracker widget, spell-slot pips, equipment toggles, and session
	// notes in the Interactive Character Sheet — replaces sessionStorage (see v1.1.1).
	pluginState: Map<string, string> = new Map();
	rollHistory: DiceRoll[] = [];

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new DnDBeyondSettingTab(this.app, this as unknown as DnDBeyondSettingTab["plugin"]));

		this.addRibbonIcon("user-plus", "Import D&D Beyond character", () => {
			new ImportModal(this.app, this as unknown as ImportModal["plugin"]).open();
		});

		this.addCommand({
			id: "import-dndbeyond-character",
			name: "Import D&D Beyond character",
			callback: () => {
				new ImportModal(this.app, this as unknown as ImportModal["plugin"]).open();
			},
		});

		this.addCommand({
			id: "open-dice-roller",
			name: "Open Dice Roller",
			callback: () => {
				new DiceRollerModal(this.app, this as unknown as DiceRollerModal["plugin"]).open();
			},
		});

		this.addCommand({
			id: "open-hp-tracker",
			name: "Open HP Tracker (legacy)",
			callback: () => {
				const firstId = this.charCache.keys().next().value as string | undefined;
				if (!firstId) {
					new Notice("Import a D&D Beyond character first.", 3000);
					return;
				}
				new HPTrackerModal(this.app, this as unknown as HPTrackerModal["plugin"], firstId).open();
			},
		});

		// ── HP Tracker Code Block Processor ───────────────────────────────────────
		this.registerMarkdownCodeBlockProcessor("dnd-hp-tracker", (source: string, el: HTMLElement) => {
			const params: Record<string, string> = {};
			for (const line of source.split("\n")) {
				const parts = line.split(":");
				const k = parts[0] ?? "";
				const v = parts[1] ?? "";
				if (k && v) params[k.trim()] = v.trim();
			}
			const charId  = params["charId"] ?? "0";
			const maxHp   = parseInt(params["maxHp"]     ?? "30", 10);
			const initCur = parseInt(params["currentHp"] ?? String(maxHp), 10);
			const initTmp = parseInt(params["tempHp"]    ?? "0",  10);
			const STORE_KEY = `dnd-hp-${charId}`;

			const loadState = (): HPState => {
				try {
					const raw = this.pluginState.get(STORE_KEY);
					if (raw) { const s = JSON.parse(raw) as HPState; s.max = maxHp; return s; }
				} catch { /* */ }
				return { max: maxHp, current: initCur, temp: initTmp, dsS: 0, dsF: 0, log: [] };
			};
			const saveState = (s: HPState) => this.pluginState.set(STORE_KEY, JSON.stringify(s));
			let state = loadState();

			const w = el.createEl("div", { cls: "dndbi-hp-widget" });
			const hdr = w.createEl("div", { cls: "dndbi-hp-header" });
			hdr.setText("❤️ HP Tracker");

			const barWrap = w.createEl("div", { cls: "dndbi-hp-bar-wrap" });
			const barFill = barWrap.createEl("div", { cls: "dndbi-hp-bar-fill" });
			const barLbl  = barWrap.createEl("div", { cls: "dndbi-hp-bar-label" });
			const tempBadge = w.createEl("div", { cls: "dndbi-hp-temp-badge" });

			const dsSuccessPips: HTMLButtonElement[] = [];
			const dsFailurePips: HTMLButtonElement[] = [];

			const render = () => {
				const pct = Math.max(0, Math.min(100, (state.current / state.max) * 100));
				barFill.style.width = pct + "%";
				barFill.classList.toggle("is-high", pct > 50);
				barFill.classList.toggle("is-mid",  pct > 25 && pct <= 50);
				barFill.classList.toggle("is-low",  pct <= 25);
				barLbl.textContent = `${state.current} / ${state.max} HP`;
				tempBadge.textContent = state.temp > 0 ? `💙 +${state.temp} temp HP` : "";
				dsSuccessPips.forEach((p, i) => { p.classList.toggle("is-filled", i < state.dsS); });
				dsFailurePips.forEach((p, i) => { p.classList.toggle("is-filled", i < state.dsF); });
				logEl.empty();
				(state.log ?? []).slice(0, 20).forEach((entry) => {
					const row = logEl.createEl("div", { cls: "dndbi-hp-log-entry" });
					row.setText(entry);
				});
				saveState(state);
			};

			const addLog = (msg: string) => {
				const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
				state.log = state.log ?? []; state.log.unshift(`[${t}] ${msg}`);
				if (state.log.length > 20) state.log.length = 20;
			};

			const dmgRow = w.createEl("div", { cls: "dndbi-hp-dmg-row" });
			const amtInput = activeDocument.createElement("input");
			amtInput.className = "dndbi-hp-amt-input";
			amtInput.type = "number"; amtInput.min = "0"; amtInput.value = "1";
			dmgRow.appendChild(amtInput);
			const getAmt = () => Math.max(0, parseInt(amtInput.value, 10) || 0);

			const dmgBtn = dmgRow.createEl("button", { cls: "dndbi-hp-dmg-btn" });
			dmgBtn.setText("⚔️ Damage");
			dmgBtn.addEventListener("click", () => {
				const n = getAmt(); const ft = Math.min(state.temp, n);
				state.temp -= ft; state.current = Math.max(0, state.current - (n - ft));
				addLog(`⚔️ −${n} dmg → ${state.current} HP`); render();
			});

			const healBtn = dmgRow.createEl("button", { cls: "dndbi-hp-heal-btn" });
			healBtn.setText("💚 Heal");
			healBtn.addEventListener("click", () => {
				const n = getAmt(); state.current = Math.min(state.max, state.current + n);
				addLog(`💚 +${n} heal → ${state.current} HP`); render();
			});

			const quickRow = w.createEl("div", { cls: "dndbi-hp-quick-row" });
			const qBtn = (lbl: string, d: number) => {
				const b = quickRow.createEl("button", { cls: "dndbi-hp-quick-btn" });
				b.setText(lbl);
				b.addEventListener("click", () => {
					if (d < 0) { const ft = Math.min(state.temp,-d); state.temp-=ft; state.current=Math.max(0,state.current-(-d-ft)); addLog(`⚔️ ${d} → ${state.current} HP`); }
					else if (d === 0) { state.current=state.max; addLog(`✨ Full rest → ${state.max} HP`); }
					else { state.current=Math.min(state.max,state.current+d); addLog(`💚 +${d} → ${state.current} HP`); }
					render();
				});
			};
			qBtn("−10",-10); qBtn("−5",-5); qBtn("−1",-1); qBtn("Full",0); qBtn("+1",1); qBtn("+5",5); qBtn("+10",10);

			const tmpRow = w.createEl("div", { cls: "dndbi-hp-tmp-row" });
			const tmpLbl = tmpRow.createEl("span", { cls: "dndbi-hp-tmp-label" });
			tmpLbl.setText("Temp HP:");
			const tmpInput = activeDocument.createElement("input");
			tmpInput.className = "dndbi-hp-tmp-input";
			tmpInput.type = "number"; tmpInput.min = "0"; tmpInput.value = String(state.temp);
			tmpRow.appendChild(tmpInput);
			const setTmpBtn = tmpRow.createEl("button", { cls: "dndbi-hp-tmp-set-btn" });
			setTmpBtn.setText("Set");
			setTmpBtn.addEventListener("click", () => {
				state.temp = Math.max(0, parseInt(tmpInput.value, 10) || 0);
				addLog(`💙 Temp HP set to ${state.temp}`); render();
			});
			const clrTmpBtn = tmpRow.createEl("button", { cls: "dndbi-hp-tmp-clr-btn" });
			clrTmpBtn.setText("Clear");
			clrTmpBtn.addEventListener("click", () => {
				state.temp=0; tmpInput.value="0"; addLog("💙 Temp HP cleared"); render();
			});

			const dsSection = w.createEl("div", { cls: "dndbi-hp-ds-section" });
			const dsTitle = dsSection.createEl("div", { cls: "dndbi-hp-ds-title" });
			dsTitle.setText("Death Saves");
			const dsRow = dsSection.createEl("div", { cls: "dndbi-hp-ds-row" });

			const makePips = (
				flavour: "is-success" | "is-failure",
				pips: HTMLButtonElement[],
				get: () => number,
				set: (n: number) => void,
			) => {
				const grp = dsRow.createEl("div", { cls: "dndbi-hp-ds-pip-group" });
				for (let i = 1; i <= 3; i++) {
					const p = activeDocument.createElement("button");
					p.className = `dndbi-hp-ds-pip ${flavour}`;
					grp.appendChild(p);
					const idx = i;
					p.addEventListener("click", () => { set(get() >= idx ? idx - 1 : idx); render(); });
					pips.push(p);
				}
			};
			makePips("is-success", dsSuccessPips, () => state.dsS, (n) => { state.dsS = n; });
			makePips("is-failure", dsFailurePips, () => state.dsF, (n) => { state.dsF = n; });

			const dsReset = dsRow.createEl("button", { cls: "dndbi-hp-ds-reset-btn" });
			dsReset.setText("Reset");
			dsReset.addEventListener("click", () => {
				state.dsS=0; state.dsF=0; addLog("🔄 Death saves reset"); render();
			});

			const logSection = w.createEl("div", { cls: "dndbi-hp-log-section" });
			const logHeader = logSection.createEl("div", { cls: "dndbi-hp-log-header" });
			const logTitle = logHeader.createEl("span", { cls: "dndbi-hp-log-title" });
			logTitle.setText("Change Log");
			const clrLog = logHeader.createEl("button", { cls: "dndbi-hp-log-clr-btn" });
			clrLog.setText("Clear");
			clrLog.addEventListener("click", () => { state.log=[]; render(); });
			const logEl = logSection.createEl("div", { cls: "dndbi-hp-log-list" });

			render();
		});

		// ── Character Sheet Launcher Code Block Processor ───────────────────────
		this.registerMarkdownCodeBlockProcessor("dnd-sheet-launcher", (source: string, el: HTMLElement) => {
			const params: Record<string, string> = {};
			for (const line of source.split("\n")) {
				const parts = line.split(":");
				const k = parts[0] ?? "";
				const v = parts[1] ?? "";
				if (k && v) params[k.trim()] = v.trim();
			}
			const rawCharId = params["charId"];
			const charId = rawCharId && rawCharId !== "0" ? rawCharId : null;

			const row = el.createEl("div", { cls: "dndbi-launcher-row" });

			const sheetBtn = row.createEl("button", { cls: "dndbi-sheet-btn" });
			sheetBtn.setText("⚔️ Open Interactive Character Sheet");
			sheetBtn.addEventListener("click", () => {
				if (!charId) {
					new Notice("This note has no D&D Beyond character ID.", 3000);
					return;
				}
				const cached = this.charCache.get(charId);
				if (!cached) {
					new Notice("Import the character first so the sheet has data to display.", 3000);
					return;
				}
				new FullCharacterSheetModal(this.app, this as unknown as FullCharacterSheetModal["plugin"], cached.char, cached.stats, cached.pb).open();
			});

			const refreshBtn = row.createEl("button", { cls: "dndbi-refresh-btn" });
			refreshBtn.setText("🔄 Refresh from D&D Beyond");

			if (!charId) {
				refreshBtn.disabled = true;
				refreshBtn.title = "This note has no D&D Beyond character ID.";
			} else {
				refreshBtn.addEventListener("click", () => {
					const originalLabel = "🔄 Refresh from D&D Beyond";
					refreshBtn.setText("⏳ Refreshing…");
					refreshBtn.disabled = true;
					refreshBtn.classList.remove("dndbi-flash-success", "dndbi-flash-error");

					this.importCharacter(charId).then(() => {
						refreshBtn.setText("✅ Refreshed");
						refreshBtn.classList.add("dndbi-flash-success");
					}).catch((e: unknown) => {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`❌ Refresh failed: ${msg}`, 4000);
						refreshBtn.setText("❌ Refresh failed");
						refreshBtn.classList.add("dndbi-flash-error");
						console.error("[DnD Beyond Importer]", e);
					}).finally(() => {
						window.setTimeout(() => {
							refreshBtn.setText(originalLabel);
							refreshBtn.classList.remove("dndbi-flash-success", "dndbi-flash-error");
							refreshBtn.disabled = false;
						}, 1600);
					});
				});
			}
		});
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<DnDBeyondImporterSettings> | null;
		this.pluginSettings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
	}

	async saveSettings() {
		await this.saveData(this.pluginSettings);
	}

	// Fetches a character from D&D Beyond, builds/updates its Markdown note, and
	// refreshes charCache. Re-throws on failure (after showing a Notice) so callers
	// — e.g. the refresh button on the sheet launcher — can detect and react to it.
	async importCharacter(idOrUrl: string): Promise<void> {
		const id = extractCharacterId(idOrUrl);
		if (!id) {
			new Notice("Couldn't find a D&D Beyond character ID in that input.", 4000);
			throw new Error("Invalid D&D Beyond character URL or ID.");
		}

		let data: DdbApiResponse;
		try {
			const resp = await requestUrl({
				url: `https://character-service.dndbeyond.com/character/v5/character/${id}`,
				headers: { Accept: "application/json" },
			});
			data = resp.json as DdbApiResponse;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ Couldn't fetch character ${id}. Make sure the sheet is set to Public on D&D Beyond.`, 5000);
			throw new Error(`Failed to fetch D&D Beyond character ${id}: ${msg}`);
		}

		const char = data?.data;
		if (!char) {
			new Notice("❌ Unexpected response from D&D Beyond. Is the character set to Public?", 5000);
			throw new Error("Unexpected D&D Beyond API response structure.");
		}

		let markdown: string;
		try {
			markdown = buildMarkdown(data, this.pluginSettings);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ Failed to build character note: ${msg}`, 5000);
			throw e;
		}

		const folder = (this.pluginSettings.outputFolder || "Characters").trim();
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				/* folder already exists (race with another note); safe to ignore */
			}
		}

		const safeName = (char.name ?? `Character ${id}`).replace(/[\\/:*?"<>|]/g, "-").trim();
		const defaultPath = normalizePath(`${folder}/${safeName}.md`);

		// Re-import support: match on dndbeyond_id in front matter, not file name,
		// so renaming the note doesn't break future refreshes.
		const existing: TFile | undefined = this.app.vault.getMarkdownFiles().find(
			(f: TFile) => this.app.metadataCache.getFileCache(f)?.frontmatter?.["dndbeyond_id"] === char.id
		);

		try {
			if (existing) {
				await this.app.vault.modify(existing, markdown);
			} else {
				let targetPath = defaultPath;
				let suffix = 2;
				while (this.app.vault.getAbstractFileByPath(targetPath)) {
					targetPath = normalizePath(`${folder}/${safeName} (${suffix}).md`);
					suffix++;
				}
				await this.app.vault.create(targetPath, markdown);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`❌ Failed to write character note: ${msg}`, 5000);
			throw e;
		}

		this.charCache.set(String(char.id), {
			char,
			stats: computeRawStats(char),
			pb: profBonus(calcLevel(char.classes ?? [])),
		});

		new Notice(`✅ Imported ${char.name ?? "character"}.`, 3000);
	}
}
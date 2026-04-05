import type { NameThemeConfig } from './types.js';

const AGENT_COLORS = [
  '38;2;178;129;214', // purple
  '38;2;215;135;175', // pink
  '38;2;254;188;56', // gold
  '38;2;137;210;129', // green
  '38;2;0;175;175', // cyan
  '38;2;23;143;185', // blue
  '38;2;228;192;15', // yellow
  '38;2;255;135;135', // coral
];

const DEFAULT_ADJECTIVES = [
  'Swift',
  'Bright',
  'Calm',
  'Dark',
  'Epic',
  'Fast',
  'Gold',
  'Happy',
  'Iron',
  'Jade',
  'Keen',
  'Loud',
  'Mint',
  'Nice',
  'Oak',
  'Pure',
  'Quick',
  'Red',
  'Sage',
  'True',
  'Ultra',
  'Vivid',
  'Wild',
  'Young',
  'Zen',
];

const DEFAULT_NOUNS = [
  'Arrow',
  'Bear',
  'Castle',
  'Dragon',
  'Eagle',
  'Falcon',
  'Grove',
  'Hawk',
  'Ice',
  'Jaguar',
  'Knight',
  'Lion',
  'Moon',
  'Nova',
  'Owl',
  'Phoenix',
  'Quartz',
  'Raven',
  'Storm',
  'Tiger',
  'Union',
  'Viper',
  'Wolf',
  'Xenon',
  'Yak',
  'Zenith',
];

const NATURE_ADJECTIVES = [
  'Oak',
  'River',
  'Mountain',
  'Cedar',
  'Storm',
  'Meadow',
  'Frost',
  'Coral',
  'Willow',
  'Stone',
  'Ember',
  'Moss',
  'Tide',
  'Fern',
  'Cloud',
  'Pine',
];
const NATURE_NOUNS = [
  'Tree',
  'Stone',
  'Wind',
  'Brook',
  'Peak',
  'Valley',
  'Lake',
  'Ridge',
  'Creek',
  'Glade',
  'Fox',
  'Heron',
  'Sage',
  'Thorn',
  'Dawn',
  'Dusk',
];

const SPACE_ADJECTIVES = [
  'Nova',
  'Lunar',
  'Cosmic',
  'Solar',
  'Stellar',
  'Astral',
  'Nebula',
  'Orbit',
  'Pulse',
  'Quasar',
  'Void',
  'Zenith',
  'Aurora',
  'Comet',
  'Warp',
  'Ion',
];
const SPACE_NOUNS = [
  'Star',
  'Dust',
  'Ray',
  'Flare',
  'Drift',
  'Core',
  'Ring',
  'Gate',
  'Spark',
  'Beam',
  'Wave',
  'Shard',
  'Forge',
  'Bolt',
  'Glow',
  'Arc',
];

const MINIMAL_NAMES = [
  'Alpha',
  'Beta',
  'Gamma',
  'Delta',
  'Epsilon',
  'Zeta',
  'Eta',
  'Theta',
  'Iota',
  'Kappa',
  'Lambda',
  'Mu',
  'Nu',
  'Xi',
  'Omicron',
  'Pi',
  'Rho',
  'Sigma',
  'Tau',
  'Upsilon',
  'Phi',
  'Chi',
  'Psi',
  'Omega',
];

const colorCache = new Map<string, string>();

export function generateMemorableName(themeConfig?: NameThemeConfig): string {
  const themeName = themeConfig?.theme ?? 'default';

  if (themeName === 'minimal') {
    return MINIMAL_NAMES[Math.floor(Math.random() * MINIMAL_NAMES.length)];
  }

  let adjectives: string[];
  let nouns: string[];

  switch (themeName) {
    case 'nature':
      adjectives = NATURE_ADJECTIVES;
      nouns = NATURE_NOUNS;
      break;
    case 'space':
      adjectives = SPACE_ADJECTIVES;
      nouns = SPACE_NOUNS;
      break;
    case 'custom':
      adjectives = themeConfig?.customWords?.adjectives ?? DEFAULT_ADJECTIVES;
      nouns = themeConfig?.customWords?.nouns ?? DEFAULT_NOUNS;
      break;
    default:
      adjectives = DEFAULT_ADJECTIVES;
      nouns = DEFAULT_NOUNS;
      break;
  }

  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return adj + noun;
}

export function isValidAgentName(name: string): boolean {
  if (!name || name.length > 50) return false;
  return /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(name);
}

export function agentColorCode(name: string): string {
  const cached = colorCache.get(name);
  if (cached) return cached;

  let hash = 0;
  for (const char of name) hash = (hash << 5) - hash + char.charCodeAt(0);
  const color = AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
  colorCache.set(name, color);
  return color;
}

export function coloredAgentName(name: string): string {
  return `\x1b[${agentColorCode(name)}m${name}\x1b[0m`;
}

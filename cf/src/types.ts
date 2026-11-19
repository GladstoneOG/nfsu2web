export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ROOM_SWITCH: DurableObjectNamespace;
  MAX_PEERS?: string;
  CF_TURN_TOKEN_ID?: string;
  CF_TURN_API_TOKEN?: string;
}

export const BLOCK = 1 << 20; // 1 MiB
export const BLOCKS_MAX = 8;

export const GAME_ENTRIES: ReadonlySet<string> = new Set([
  "speed2.exe",
  "server.dll",
  "server.cfg",
  "cars",
  "credits",
  "frontend",
  "global",
  "hqvinyls",
  "langpacks",
  "languages",
  "memcard",
  "modpacks",
  "movies",
  "nis",
  "pfdata",
  "sdata",
  "sound",
  "speech",
  "subtitles",
  "texpacks",
  "tracks",
  "vinylpacks",
]);

export const ROBOTS_TXT =
  "User-agent: *\nAllow: /\nDisallow: /data/\nDisallow: /data-manifest\nDisallow: /game.wasm\nDisallow: /game.json\nDisallow: /players\nDisallow: /seen\nDisallow: /lan\nDisallow: /vault\nDisallow: /names\nDisallow: /friends";

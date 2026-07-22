#!/usr/bin/env node
/**
 * parse-address.js
 *
 * 把使用者的自然語言查詢，解析成結構化的查詢條件物件。
 * 這支腳本刻意保持「保守」：無法確定的欄位一律留空，並在 needsClarification
 * 中列出必須反問使用者的問題，交由呼叫端（Claude / SKILL.md 流程）決定是否
 * 要先跟使用者確認，而不是自己亂猜。
 *
 * Usage:
 *   node parse-address.js --text "幫我查新北市中和區秀朗路三段最近半年的成交行情"
 *
 * Output (stdout): JSON
 */

// 22 縣市對照（依 /SERVICE/CITY 實際回傳整理，code 供 lvr-client 使用）
const CITY_TABLE = [
  { code: "C", name: "基隆市" }, { code: "A", name: "臺北市" },
  { code: "F", name: "新北市" }, { code: "H", name: "桃園市" },
  { code: "O", name: "新竹市" }, { code: "J", name: "新竹縣" },
  { code: "K", name: "苗栗縣" }, { code: "B", name: "臺中市" },
  { code: "M", name: "南投縣" }, { code: "N", name: "彰化縣" },
  { code: "P", name: "雲林縣" }, { code: "I", name: "嘉義市" },
  { code: "Q", name: "嘉義縣" }, { code: "D", name: "臺南市" },
  { code: "E", name: "高雄市" }, { code: "T", name: "屏東縣" },
  { code: "G", name: "宜蘭縣" }, { code: "U", name: "花蓮縣" },
  { code: "V", name: "臺東縣" }, { code: "X", name: "澎湖縣" },
  { code: "W", name: "金門縣" }, { code: "Z", name: "連江縣" },
];

// 常見「市」簡寫（例如「花蓮市」是花蓮縣底下的鄉鎮市，不是縣市本身）
// 這種情況縣市要對應到「花蓮縣」，鄉鎮市區要對應到「花蓮市」
const CITY_ALIASES = {
  "台北": "臺北市", "北市": "臺北市", "台北市": "臺北市",
  "新北": "新北市",
  "台中": "臺中市", "台中市": "臺中市",
  "台南": "臺南市", "台南市": "臺南市",
  "高雄": "高雄市",
  "桃園": "桃園市",
  "新竹市": "新竹市", "新竹縣": "新竹縣",
  "嘉義市": "嘉義市", "嘉義縣": "嘉義縣",
  "基隆": "基隆市",
  "花蓮": "花蓮縣", "花蓮市": "花蓮縣", // 花蓮市為鄉鎮市，縣為花蓮縣
  "台東": "臺東縣", "臺東": "臺東縣",
};

function findCity(text) {
  for (const c of CITY_TABLE) {
    if (text.includes(c.name)) return c;
  }
  for (const [alias, full] of Object.entries(CITY_ALIASES)) {
    if (text.includes(alias)) {
      const c = CITY_TABLE.find((c) => c.name === full);
      if (c) return c;
    }
  }
  return null;
}

// 抓「路/街 + 段 + 巷弄 + 門牌」的粗略 pattern，實際比對交給網站的地址欄位
const ROAD_PATTERN = /([\u4e00-\u9fa5]{1,6}(?:路|街|大道))((?:\d+|[一二三四五六七八九十]+)段)?(\d+巷)?(\d+弄)?(\d+號)?/;
const COMMUNITY_PATTERN = /([\u4e00-\u9fa50-9]{2,10}?(?:社區|大樓|花園|山莊|新城|大廈))/;

function detectQueryType(text) {
  if (/租|租金|租賃/.test(text)) return "rent";
  if (/預售|預售屋|預售案|建案/.test(text)) return "presale";
  return "sale"; // 預設買賣
}

function detectPropertyType(text) {
  const types = [];
  if (/公寓/.test(text)) types.push("公寓");
  if (/華廈/.test(text)) types.push("華廈");
  if (/住宅大樓|大樓/.test(text)) types.push("住宅大樓");
  if (/透天|透天厝/.test(text)) types.push("透天厝");
  if (/套房/.test(text)) types.push("套房");
  return types;
}

function detectParking(text) {
  if (/含車位|有車位|帶車位/.test(text)) return true;
  if (/無車位|不含車位|不帶車位/.test(text)) return false;
  return null; // 不限
}

const DISTRICT_PATTERN = /([\u4e00-\u9fa5]{1,3}(?:區|鄉|鎮|市))/;

function parse(text) {
  const result = {
    raw_text: text,
    queryType: detectQueryType(text),
    city: null,
    cityCode: null,
    district: null,
    road: null,
    section: null,
    lane: null,
    alley: null,
    number: null,
    community: null,
    period: "recent_6m", // 預設最近半年，由查詢端動態換算日期
    dealTarget: "房地及房地含車位", // 預設
    propertyTypes: detectPropertyType(text),
    hasParking: detectParking(text),
    areaRange: null, // 未指定
    ageRange: null,
    floor: null,
    needsClarification: [],
  };

  // 先移除常見語助詞/發語詞，避免「幫我查」「請問」「查一下」等字樣被誤判為地址的一部分
  const FILLER_PATTERN = /(幫我查一下|幫我查詢|幫我查|請問|請幫我|想查詢|想查|查一下|查詢一下|麻煩查|查詢|查看|查)/g;
  let remainder = text.replace(FILLER_PATTERN, "");

  const city = findCity(text);
  if (city) {
    result.city = city.name;
    result.cityCode = city.code;
    const aliasesToStrip = [city.name, ...Object.keys(CITY_ALIASES).filter((a) => CITY_ALIASES[a] === city.name)]
      .sort((a, b) => b.length - a.length);
    for (const alias of aliasesToStrip) {
      // 別名本身若是「XX市/區/鎮/鄉」且不等於縣市全名（例如「花蓮市」隸屬「花蓮縣」），
      // 代表使用者其實講的是鄉鎮市名稱，順便記錄為行政區
      if (alias !== city.name && /(市|區|鎮|鄉)$/.test(alias) && remainder.includes(alias)) {
        result.district = alias;
      }
      remainder = remainder.split(alias).join("");
    }
  }

  const districtMatch = remainder.match(DISTRICT_PATTERN);
  if (districtMatch) {
    result.district = districtMatch[1];
    remainder = remainder.replace(districtMatch[1], "");
  }

  const roadMatch = remainder.match(ROAD_PATTERN);
  if (roadMatch) {
    result.road = roadMatch[1] || null;
    result.section = roadMatch[2] || null;
    result.lane = roadMatch[3] || null;
    result.alley = roadMatch[4] || null;
    result.number = roadMatch[5] || null;
  }

  const communityMatch = remainder.match(COMMUNITY_PATTERN);
  if (communityMatch) {
    result.community = communityMatch[1];
  }

  // 期間關鍵字覆寫預設值
  if (/最近1年|最近一年/.test(text)) result.period = "recent_1y";
  else if (/最近2年|最近兩年/.test(text)) result.period = "recent_2y";
  else if (/最近5年|最近五年/.test(text)) result.period = "recent_5y";
  else if (/最近半年/.test(text)) result.period = "recent_6m";

  // 缺縣市但有路名門牌 → 必須反問，不可自行猜測（SKILL.md 四、要求）
  if (!result.city && (result.road || result.number)) {
    result.needsClarification.push(
      `偵測到路名/門牌「${result.road || ""}${result.number || ""}」，但台灣多個縣市可能有同名路段，請提供縣市與行政區。`
    );
  }
  if (!result.city && !result.community && !result.road) {
    result.needsClarification.push("無法從輸入判斷查詢地點，請提供至少縣市＋行政區，或社區名稱。");
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const textIdx = args.indexOf("--text");
  const textFileIdx = args.indexOf("--text-file");

  let text;
  if (textFileIdx !== -1 && args[textFileIdx + 1]) {
    const fs = await import("node:fs");
    text = fs.readFileSync(args[textFileIdx + 1], "utf-8").replace(/^\uFEFF/, "").trim();
  } else if (textIdx !== -1 && args[textIdx + 1]) {
    text = args[textIdx + 1];
  } else if (args[0] && !args[0].startsWith("--")) {
    text = args.join(" ");
  } else {
    console.error(JSON.stringify({ error: "缺少查詢文字，請直接提供文字，或使用 --text \"...\"、--text-file <檔案路徑>" }));
    process.exit(1);
  }
  const parsed = parse(text);
  console.log(JSON.stringify(parsed, null, 2));
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { parse, findCity, CITY_TABLE };

#!/usr/bin/env node
/**
 * analyze-transactions.js
 *
 * 讀取 query-lvr.js 產生的實價登錄查詢結果，執行：
 *
 * 1. 實價登錄欄位與單位正規化
 * 2. 特殊交易辨識
 * 3. 增建案例分級
 * 4. 嚴格行情與參考行情兩層統計
 * 5. 依建物型態分開統計
 * 6. 比較案例排序
 *
 * 使用方式：
 *
 * node .\scripts\analyze-transactions.js --input ".\debug\raw.json"
 *
 * node .\scripts\analyze-transactions.js `
 *   --input ".\debug\raw.json" `
 *   --target '{"road":"秀朗路三段","marketSegment":"住宅"}'
 *
 * 也可以從 stdin 輸入：
 *
 * Get-Content ".\debug\raw.json" -Raw -Encoding UTF8 |
 *   node .\scripts\analyze-transactions.js
 */

import fs from "node:fs";
import path from "node:path";
import {
  fileURLToPath,
  pathToFileURL,
} from "node:url";

const SCRIPT_DIR = path.dirname(
  fileURLToPath(import.meta.url),
);
const SKILL_DIR = path.resolve(
  SCRIPT_DIR,
  "..",
);
const DEBUG_DIR = path.join(
  SKILL_DIR,
  "debug",
);
const ANALYSIS_OUTPUT_PATH = path.join(
  DEBUG_DIR,
  "analysis.json",
);

function writeAnalysisResult(result) {
  fs.mkdirSync(DEBUG_DIR, {
    recursive: true,
  });

  fs.writeFileSync(
    ANALYSIS_OUTPUT_PATH,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

const SQM_PER_PING = 3.305785;
const TW_YEAR_OFFSET = 1911;

const AREA_UNIT = {
  SQUARE_METER: "1",
  PING: "2",
};

/**
 * 不論嚴格行情或參考行情，預設都排除的特殊交易。
 */
const HARD_SPECIAL_KEYWORDS = {
  親友或關係人交易: [
    "親友",
    "員工",
    "共有人",
    "特殊關係",
  ],

  部分持分交易: [
    "持分",
    "權利範圍",
    "部分產權",
  ],

  債務抵償: [
    "抵償",
    "抵債",
  ],

  含裝潢費: [
    "裝潢",
  ],

  毛胚屋: [
    "毛胚",
  ],

  含租約: [
    "含租約",
    "租約",
  ],
};

/**
 * 一般增建：
 * - 嚴格行情排除
 * - 參考行情保留，但加上警示
 */
const MILD_ADDITION_KEYWORDS = [
  "陽台外推",
  "其他增建",
  "增建",
];

/**
 * 重大增建或用途改造：
 * - 嚴格行情排除
 * - 參考行情也排除
 */
const SEVERE_ADDITION_KEYWORDS = [
  "頂樓加蓋",
  "未保存登記",
  "違建",
  "隔套",
  "夾層",
  "增建未登記",
  "未辦保存登記",
];

function toNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const normalized = String(value)
    .replace(/,/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const number = Number(normalized);

  return Number.isFinite(number)
    ? number
    : null;
}

function minguoToDate(value) {
  const match = String(value || "").match(
    /^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/,
  );

  if (!match) {
    return null;
  }

  const [, year, month, day] = match;

  const result = new Date(
    Number(year) + TW_YEAR_OFFSET,
    Number(month) - 1,
    Number(day),
  );

  return Number.isNaN(result.getTime())
    ? null
    : result;
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * 將官網較長的建物型態名稱歸併成統一類別。
 */
function normalizeBuildingType(recordOrText) {
  const raw =
    typeof recordOrText === "string"
      ? recordOrText
      : String(recordOrText?.b || "");

  if (raw.includes("公寓")) {
    return "公寓";
  }

  if (raw.includes("華廈")) {
    return "華廈";
  }

  if (
    raw.includes("住宅大樓") ||
    raw.includes("大樓")
  ) {
    return "住宅大樓";
  }

  if (raw.includes("透天")) {
    return "透天厝";
  }

  if (raw.includes("套房")) {
    return "套房";
  }

  if (raw.includes("店面")) {
    return "店面";
  }

  if (raw.includes("辦公")) {
    return "辦公室";
  }

  if (raw.includes("廠房")) {
    return "廠房";
  }

  if (raw.includes("倉庫")) {
    return "倉庫";
  }

  return raw.trim() || "未分類";
}

function detectMarketSegment(record) {
  const transactionType = String(
    record.t || "",
  );

  const buildingType = String(
    record.b || "",
  );

  const purpose = String(
    record.pu || "",
  );

  const hasLand =
    transactionType.includes("土地");

  const hasBuilding =
    transactionType.includes("建物") ||
    transactionType.includes("房地");

  const hasParking =
    transactionType.includes("車位");

  if (
    hasParking &&
    !hasLand &&
    !hasBuilding
  ) {
    return "parking";
  }

  if (
    hasLand &&
    !hasBuilding
  ) {
    return "land";
  }

  if (
    buildingType.includes("店面") ||
    buildingType.includes("辦公") ||
    purpose.includes("商業") ||
    purpose.includes("辦公")
  ) {
    return "commercial";
  }

  if (
    hasBuilding ||
    buildingType.includes("公寓") ||
    buildingType.includes("華廈") ||
    buildingType.includes("住宅大樓") ||
    buildingType.includes("透天") ||
    buildingType.includes("套房")
  ) {
    return "residential";
  }

  return "other";
}

/**
 * 將增建分為：
 *
 * none   ：沒有增建資訊
 * mild   ：陽台外推、一般其他增建
 * severe ：頂樓加蓋、未保存登記、違建、隔套、夾層
 */
function classifyAddition(record) {
  const text = [
    record.note,
    record.a,
    record.b,
    record.f,
  ]
    .filter(Boolean)
    .join(" ");

  const severeMatches =
    SEVERE_ADDITION_KEYWORDS.filter(
      (keyword) => text.includes(keyword),
    );

  if (severeMatches.length > 0) {
    return {
      severity: "severe",
      label: "重大增建或未保存登記",
      keywords: unique(severeMatches),
    };
  }

  const mildMatches =
    MILD_ADDITION_KEYWORDS.filter(
      (keyword) => text.includes(keyword),
    );

  if (mildMatches.length > 0) {
    return {
      severity: "mild",
      label: "一般增建或陽台外推",
      keywords: unique(mildMatches),
    };
  }

  return {
    severity: "none",
    label: null,
    keywords: [],
  };
}

function classifyRecord(record) {
  const hardFlags = [];

  const note = String(
    record.note || "",
  );

  const address = String(
    record.a || "",
  );

  const buildingType = String(
    record.b || "",
  );

  const floor = String(
    record.f || "",
  );

  const transactionType = String(
    record.t || "",
  );

  for (
    const [label, keywords]
    of Object.entries(HARD_SPECIAL_KEYWORDS)
  ) {
    if (
      keywords.some(
        (keyword) => note.includes(keyword),
      )
    ) {
      hardFlags.push(label);
    }
  }

  if (
    address.includes("地下室") ||
    floor.includes("地下層") ||
    buildingType.includes("地下室")
  ) {
    hardFlags.push("地下室");
  }

  const hasLand =
    transactionType.includes("土地");

  const hasBuilding =
    transactionType.includes("建物") ||
    transactionType.includes("房地");

  if (
    hasBuilding &&
    !hasLand &&
    !transactionType.includes("房地")
  ) {
    hardFlags.push("純建物交易");
  }

  const addition =
    classifyAddition(record);

  const flags = [
    ...hardFlags,
    ...(addition.label
      ? [addition.label]
      : []),
  ];

  return {
    flags: unique(flags),
    hardFlags: unique(hardFlags),
    addition,
    segment:
      detectMarketSegment(record),
  };
}

function computeArea(record) {
  const rawArea = toNumber(record.s);

  const unit = String(
    record.unit ?? "",
  );

  if (rawArea === null) {
    return {
      areaSqm: null,
      areaPing: null,
      areaUnit: null,
      warning: "本筆交易缺少面積。",
    };
  }

  if (unit === AREA_UNIT.PING) {
    return {
      areaSqm:
        rawArea * SQM_PER_PING,
      areaPing: rawArea,
      areaUnit: "坪",
      warning: null,
    };
  }

  if (
    unit === AREA_UNIT.SQUARE_METER
  ) {
    return {
      areaSqm: rawArea,
      areaPing:
        rawArea / SQM_PER_PING,
      areaUnit: "平方公尺",
      warning: null,
    };
  }

  return {
    areaSqm: null,
    areaPing: null,
    areaUnit: null,
    warning:
      `無法辨識面積單位 unit=${unit || "空白"}，` +
      "未進行面積換算。",
  };
}

function computeUnitPrice(record) {
  const rawPrice = toNumber(record.p);

  const unit = String(
    record.unit ?? "",
  );

  const transactionType = String(
    record.t || "",
  );

  const message = String(
    record.msg || "",
  );

  const warnings = [];

  let pricePerSqm = null;
  let pricePerPing = null;
  let sourceUnit = null;

  if (rawPrice === null) {
    warnings.push(
      "本筆交易缺少成交單價。",
    );
  } else if (
    unit === AREA_UNIT.PING
  ) {
    pricePerPing = rawPrice;
    pricePerSqm =
      rawPrice / SQM_PER_PING;
    sourceUnit = "元／坪";
  } else if (
    unit === AREA_UNIT.SQUARE_METER
  ) {
    pricePerSqm = rawPrice;
    pricePerPing =
      rawPrice * SQM_PER_PING;
    sourceUnit = "元／平方公尺";
  } else {
    warnings.push(
      `無法辨識單價面積單位 unit=${unit || "空白"}，` +
      "未進行單價換算。",
    );
  }

  const includesParking =
    transactionType.includes("車位");

  const parkingExcluded =
    message.includes("總價-車位總價") ||
    (
      message.includes("車位總價") &&
      message.includes("車位總面積")
    );

  if (
    includesParking &&
    !parkingExcluded
  ) {
    warnings.push(
      "本筆交易包含車位，但回傳資訊未明確表示車位價格及面積已拆分，單價可能受到車位影響。",
    );
  }

  return {
    pricePerSqm,
    pricePerPing,

    pricePerPingWan:
      pricePerPing !== null
        ? pricePerPing / 10000
        : null,

    sourceUnit,

    warning:
      warnings.length > 0
        ? warnings.join(" ")
        : null,
  };
}

function enrichRecord(record) {
  const classification =
    classifyRecord(record);

  const price =
    computeUnitPrice(record);

  const area =
    computeArea(record);

  const totalPrice =
    toNumber(record.tp);

  const age =
    toNumber(record.g);

  const parkingPriceWan =
    toNumber(record.cp);

  return {
    ...record,

    _date:
      minguoToDate(record.e),

    _marketSegment:
      classification.segment,

    _buildingType:
      normalizeBuildingType(record),

    _flags:
      classification.flags,

    _hardFlags:
      classification.hardFlags,

    _additionSeverity:
      classification.addition.severity,

    _additionLabel:
      classification.addition.label,

    _additionKeywords:
      classification.addition.keywords,

    _areaSqm:
      area.areaSqm,

    _areaPing:
      area.areaPing,

    _areaUnit:
      area.areaUnit,

    _pricePerSqm:
      price.pricePerSqm,

    _pricePerPing:
      price.pricePerPing,

    _pricePerPingWan:
      price.pricePerPingWan,

    _priceSourceUnit:
      price.sourceUnit,

    _totalPrice:
      totalPrice,

    _totalPriceWan:
      totalPrice !== null
        ? totalPrice / 10000
        : null,

    _age:
      age,

    _parkingPriceWan:
      parkingPriceWan,

    _warning:
      [
        area.warning,
        price.warning,
      ]
        .filter(Boolean)
        .join(" ") || null,
  };
}

function normalizeTargetSegment(target) {
  const raw = String(
    target?.marketSegment ??
      target?.assetType ??
      target?.category ??
      target?.propertyType ??
      "",
  );

  if (raw.includes("土地")) {
    return "land";
  }

  if (raw.includes("車位")) {
    return "parking";
  }

  if (
    raw.includes("店面") ||
    raw.includes("辦公") ||
    raw.includes("商業")
  ) {
    return "commercial";
  }

  return "residential";
}

function normalizeTargetBuildingType(target) {
  const raw = String(
    target?.buildingType ??
      target?.propertyType ??
      "",
  ).trim();

  if (!raw) {
    return null;
  }

  if (
    raw === "住宅" ||
    raw === "住宅類" ||
    raw === "房屋" ||
    raw === "房地"
  ) {
    return null;
  }

  const normalized =
    normalizeBuildingType(raw);

  return normalized === "未分類"
    ? null
    : normalized;
}

/**
 * mode:
 *
 * strict
 * 嚴格行情：排除所有增建。
 *
 * reference
 * 參考行情：保留一般增建，排除重大增建。
 */
function getExclusionReasons(
  record,
  target,
  mode,
) {
  const reasons = [];

  const targetSegment =
    normalizeTargetSegment(target);

  if (
    record._marketSegment !==
    targetSegment
  ) {
    reasons.push(
      `市場類型不符：目標為 ${targetSegment}，案例為 ${record._marketSegment}`,
    );
  }

  if (
    target?.includeSpecial !== true
  ) {
    reasons.push(
      ...record._hardFlags,
    );
  }

  if (
    mode === "strict" &&
    record._additionSeverity === "mild"
  ) {
    reasons.push(
      "嚴格行情排除一般增建或陽台外推",
    );
  }

  if (
    record._additionSeverity === "severe" &&
    target?.includeSevereAdditions !== true
  ) {
    reasons.push(
      "重大增建或未保存登記",
    );
  }

  if (
    record._pricePerPing === null
  ) {
    reasons.push(
      "缺少可用的每坪單價",
    );
  } else if (
    record._pricePerPing <= 0
  ) {
    reasons.push(
      "每坪單價不是正數",
    );
  }

  if (
    record._areaPing !== null &&
    record._areaPing <= 0
  ) {
    reasons.push(
      "面積不是正數",
    );
  }

  return unique(reasons);
}

function median(values) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort(
    (a, b) => a - b,
  );

  const middle =
    Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (
    sorted[middle - 1] +
    sorted[middle]
  ) / 2;
}

function percentile(values, proportion) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort(
    (a, b) => a - b,
  );

  const index =
    (sorted.length - 1) *
    proportion;

  const lower =
    Math.floor(index);

  const upper =
    Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  return (
    sorted[lower] +
    (
      sorted[upper] -
      sorted[lower]
    ) *
      (index - lower)
  );
}

function toWanPerPing(value) {
  return value !== null
    ? value / 10000
    : null;
}

function summarizeRecords(
  validRecords,
  {
    rawCount,
    excludedCount,
    label = null,
    buildingType = null,
  },
) {
  const prices =
    validRecords
      .map(
        (record) =>
          record._pricePerPing,
      )
      .filter(
        (value) =>
          value !== null &&
          value > 0,
      );

  const totalPrices =
    validRecords
      .map(
        (record) =>
          record._totalPrice,
      )
      .filter(
        (value) =>
          value !== null &&
          value > 0,
      );

  const minPrice =
    prices.length > 0
      ? Math.min(...prices)
      : null;

  const maxPrice =
    prices.length > 0
      ? Math.max(...prices)
      : null;

  const avgPrice =
    prices.length > 0
      ? prices.reduce(
          (sum, value) =>
            sum + value,
          0,
        ) / prices.length
      : null;

  const medianPrice =
    median(prices);

  const mainRangeLow =
    percentile(prices, 0.25);

  const mainRangeHigh =
    percentile(prices, 0.75);

  const avgTotalPrice =
    totalPrices.length > 0
      ? totalPrices.reduce(
          (sum, value) =>
            sum + value,
          0,
        ) / totalPrices.length
      : null;

  return {
    label,
    buildingType,

    rawCount,

    validCount:
      validRecords.length,

    excludedCount,

    minPricePerPing:
      minPrice,

    minPricePerPingWan:
      toWanPerPing(minPrice),

    maxPricePerPing:
      maxPrice,

    maxPricePerPingWan:
      toWanPerPing(maxPrice),

    avgPricePerPing:
      avgPrice,

    avgPricePerPingWan:
      toWanPerPing(avgPrice),

    medianPricePerPing:
      medianPrice,

    medianPricePerPingWan:
      toWanPerPing(medianPrice),

    mainRangeLow,

    mainRangeLowWan:
      toWanPerPing(mainRangeLow),

    mainRangeHigh,

    mainRangeHighWan:
      toWanPerPing(mainRangeHigh),

    avgTotalPrice,

    avgTotalPriceWan:
      avgTotalPrice !== null
        ? avgTotalPrice / 10000
        : null,
  };
}

function scoreAgainstTarget(
  record,
  target,
) {
  if (!target) {
    return record._date
      ? record._date.getTime() / 1e15
      : 0;
  }

  let score = 0;

  if (
    target.community &&
    record.bn &&
    String(record.bn).trim() ===
      String(target.community).trim()
  ) {
    score += 1000;
  }

  if (
    target.address &&
    record.a &&
    String(record.a).includes(
      String(target.address),
    )
  ) {
    score += 800;
  }

  if (
    target.road &&
    record.a &&
    String(record.a).includes(
      String(target.road),
    )
  ) {
    score += 500;
  }

  const targetBuildingType =
    normalizeTargetBuildingType(target);

  if (
    targetBuildingType &&
    record._buildingType ===
      targetBuildingType
  ) {
    score += 300;
  }

  if (
    target.areaPing !== undefined &&
    record._areaPing !== null
  ) {
    score -=
      Math.abs(
        record._areaPing -
          Number(target.areaPing),
      ) * 2;
  }

  if (
    target.age !== undefined &&
    record._age !== null
  ) {
    score -=
      Math.abs(
        record._age -
          Number(target.age),
      );
  }

  if (
    typeof target.hasParking ===
      "boolean"
  ) {
    const hasParking =
      String(record.t || "").includes(
        "車位",
      );

    if (
      hasParking ===
      target.hasParking
    ) {
      score += 50;
    } else {
      score -= 50;
    }
  }

  if (record._date) {
    score +=
      record._date.getTime() /
      1e15;
  }

  return score;
}

function buildModeAnalysis(
  enriched,
  target,
  mode,
) {
  const evaluated =
    enriched.map((record) => {
      const exclusionReasons =
        getExclusionReasons(
          record,
          target,
          mode,
        );

      return {
        ...record,

        _analysisMode:
          mode,

        _eligibleForStats:
          exclusionReasons.length === 0,

        _exclusionReasons:
          exclusionReasons,
      };
    });

  const valid =
    evaluated.filter(
      (record) =>
        record._eligibleForStats,
    );

  const excluded =
    evaluated.filter(
      (record) =>
        !record._eligibleForStats,
    );

  const targetSegment =
    normalizeTargetSegment(target);

  const segmentRecords =
    evaluated.filter(
      (record) =>
        record._marketSegment ===
        targetSegment,
    );

  const buildingTypes =
    unique(
      segmentRecords.map(
        (record) =>
          record._buildingType,
      ),
    ).sort();

  const byBuildingType =
    buildingTypes.map(
      (buildingType) => {
        const rawGroup =
          segmentRecords.filter(
            (record) =>
              record._buildingType ===
              buildingType,
          );

        const validGroup =
          rawGroup.filter(
            (record) =>
              record._eligibleForStats,
          );

        return summarizeRecords(
          validGroup,
          {
            rawCount:
              rawGroup.length,

            excludedCount:
              rawGroup.length -
              validGroup.length,

            label:
              mode === "strict"
                ? "嚴格行情"
                : "參考行情",

            buildingType,
          },
        );
      },
    );

  const stats =
    summarizeRecords(
      valid,
      {
        rawCount:
          evaluated.length,

        excludedCount:
          excluded.length,

        label:
          mode === "strict"
            ? "嚴格行情"
            : "參考行情",
      },
    );

  stats.marketSegment =
    targetSegment;

  stats.buildingTypes =
    byBuildingType
      .filter(
        (group) =>
          group.validCount > 0,
      )
      .map(
        (group) =>
          group.buildingType,
      );

  stats.mixedBuildingTypes =
    stats.buildingTypes.length > 1;

  if (stats.mixedBuildingTypes) {
    stats.warning =
      "本層統計包含多種建物型態，正式行情判讀應優先使用 byBuildingType 的分組結果。";
  } else {
    stats.warning = null;
  }

  const comparableCases =
    [...valid].sort(
      (left, right) =>
        scoreAgainstTarget(
          right,
          target,
        ) -
        scoreAgainstTarget(
          left,
          target,
        ),
    );

  return {
    mode,
    stats,
    byBuildingType,
    comparableCases,
    excludedCases: excluded,
  };
}

function analyze(records, target = null) {
  const enriched =
    records.map(enrichRecord);

  const strict =
    buildModeAnalysis(
      enriched,
      target,
      "strict",
    );

  const reference =
    buildModeAnalysis(
      enriched,
      target,
      "reference",
    );

  const mildAdditionReferenceCases =
    reference.comparableCases.filter(
      (record) =>
        record._additionSeverity ===
        "mild",
    );

  return {
    policy: {
      strict:
        "嚴格行情排除所有增建、陽台外推、頂樓加蓋、未保存登記及其他特殊交易。",

      reference:
        "參考行情保留一般增建或陽台外推案件，但仍排除頂樓加蓋、未保存登記、違建、隔套、夾層及其他重大特殊交易。",

      buildingType:
        "公寓、華廈、住宅大樓、透天厝、套房等建物型態分開統計，不建議直接混合判讀。",
    },

    /**
     * 向下相容：
     * stats、comparableCases、excludedCases
     * 仍代表嚴格行情。
     */
    stats:
      strict.stats,

    comparableCases:
      strict.comparableCases,

    excludedCases:
      strict.excludedCases,

    strictStats:
      strict.stats,

    referenceStats:
      reference.stats,

    byBuildingType: {
      strict:
        strict.byBuildingType,

      reference:
        reference.byBuildingType,
    },

    strictComparableCases:
      strict.comparableCases,

    referenceComparableCases:
      reference.comparableCases,

    mildAdditionReferenceCases,

    strictExcludedCases:
      strict.excludedCases,

    referenceExcludedCases:
      reference.excludedCases,
  };
}

function parseTarget(args) {
  const targetFileIndex =
    args.indexOf("--target-file");

  if (
    targetFileIndex !== -1 &&
    args[targetFileIndex + 1]
  ) {
    try {
      return JSON.parse(
        fs.readFileSync(
          args[targetFileIndex + 1],
          "utf8",
        ).replace(/^\uFEFF/, ""),
      );
    } catch (error) {
      throw new Error(
        `讀取 --target-file 失敗：${error.message}`,
      );
    }
  }

  const targetIndex =
    args.indexOf("--target");

  if (
    targetIndex === -1 ||
    !args[targetIndex + 1]
  ) {
    return null;
  }

  try {
    return JSON.parse(
      args[targetIndex + 1],
    );
  } catch (error) {
    throw new Error(
      `--target 不是合法 JSON：${error.message}`,
    );
  }
}

function readInput(args) {
  const inputIndex =
    args.indexOf("--input");

  if (
    inputIndex !== -1 &&
    args[inputIndex + 1]
  ) {
    return fs.readFileSync(
      args[inputIndex + 1],
      "utf8",
    );
  }

  return fs.readFileSync(
    0,
    "utf8",
  );
}

function main() {
  const args =
    process.argv.slice(2);

  let raw;

  try {
    raw = readInput(args);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error:
            `無法讀取輸入資料：${error.message}`,
        },
        null,
        2,
      ),
    );

    process.exitCode = 1;
    return;
  }

  raw = raw.replace(
    /^\uFEFF/,
    "",
  );

  let payload;

  try {
    payload =
      JSON.parse(raw);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error:
            `輸入不是合法 JSON：${error.message}`,
        },
        null,
        2,
      ),
    );

    process.exitCode = 1;
    return;
  }

  if (
    !Array.isArray(payload) &&
    payload?.success === false
  ) {
    console.error(
      JSON.stringify(
        {
          success: false,

          error:
            "原始實價登錄查詢失敗，無法進行行情分析。",

          queryError:
            payload.error ?? null,

          blockedBySite:
            payload.blockedBySite ??
            false,

          manualActionRequired:
            payload.manualActionRequired ??
            false,

          debugFiles:
            payload.debugFiles ??
            null,

          adjustments:
            payload.adjustments ??
            [],
        },
        null,
        2,
      ),
    );

    process.exitCode = 1;
    return;
  }

  const records =
    Array.isArray(payload)
      ? payload
      : Array.isArray(payload.records)
        ? payload.records
        : [];

  if (records.length === 0) {
    console.log(
      JSON.stringify(
        {
          success: false,

          error:
            "沒有可分析的成交案例，原始查詢結果為空。",

          source: {
            finalCriteria:
              payload?.finalCriteria ??
              null,

            periodRange:
              payload?.periodRange ??
              null,

            adjustments:
              payload?.adjustments ??
              [],
          },
        },
        null,
        2,
      ),
    );

    return;
  }

  let target;

  try {
    target =
      parseTarget(args);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          success: false,
          error:
            error.message,
        },
        null,
        2,
      ),
    );

    process.exitCode = 1;
    return;
  }

  const result =
    analyze(records, target);

  const output = {
    success: true,

    source: {
      finalCriteria:
        payload?.finalCriteria ??
        null,

      periodRange:
        payload?.periodRange ??
        null,

      adjustments:
        payload?.adjustments ??
        [],
    },

    target,

    ...result,
  };

  writeAnalysisResult(output);

  console.log(
    JSON.stringify(
      output,
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(
      process.argv[1],
    ).href
) {
  main();
}

export {
  analyze,
  enrichRecord,
  classifyAddition,
  classifyRecord,
  computeArea,
  computeUnitPrice,
  detectMarketSegment,
  normalizeBuildingType,
  normalizeTargetBuildingType,
  normalizeTargetSegment,
  scoreAgainstTarget,
  SQM_PER_PING,
  writeAnalysisResult,
};

#!/usr/bin/env node
/**
 * query-lvr.js
 *
 * 主流程：
 *
 * 接收結構化查詢條件
 * → 動態計算交易期間
 * → 呼叫 lvr-client 查詢
 * → 查無資料時依規則放寬條件重試
 * → 輸出原始結果及查詢調整紀錄
 *
 * 使用方式：
 *
 * node query-lvr.js --json '{"city":"新北市","cityCode":"F","district":"中和區","road":"秀朗路","section":"三段","period":"recent_6m"}'
 *
 * node query-lvr.js --json '...' --inspect
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
const RAW_OUTPUT_PATH = path.join(
  DEBUG_DIR,
  "raw.json",
);

async function loadQueryOnce() {
  const module = await import(
    "./lvr-client.js"
  );

  return module.queryOnce;
}

function writeRawResult(result) {
  fs.mkdirSync(DEBUG_DIR, {
    recursive: true,
  });

  fs.writeFileSync(
    RAW_OUTPUT_PATH,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

const TW_YEAR_OFFSET = 1911;

/**
 * 每種期間包含的月份數。
 *
 * 因為官網查詢使用年月區間，且起訖月份都包含：
 *
 * recent_6m = 6個月份
 * recent_1y = 12個月份
 * recent_2y = 24個月份
 * recent_5y = 60個月份
 */
const PERIOD_MONTHS = Object.freeze({
  recent_6m: 6,
  recent_1y: 12,
  recent_2y: 24,
  recent_5y: 60,
});

const PERIOD_ESCALATION = [
  "recent_6m",
  "recent_1y",
  "recent_2y",
  "recent_5y",
];

/**
 * 取得今天的民國日期資訊。
 */
function todayMinguo(now = new Date()) {
  const year =
    now.getFullYear() -
    TW_YEAR_OFFSET;

  const month = String(
    now.getMonth() + 1,
  ).padStart(2, "0");

  const day = String(
    now.getDate(),
  ).padStart(2, "0");

  return {
    y: year,
    m: month,
    d: day,
    date: new Date(now),
  };
}

/**
 * 驗證期間代碼。
 *
 * 不認得的代碼預設使用最近半年。
 */
function normalizePeriod(period) {
  if (
    typeof period === "string" &&
    Object.hasOwn(
      PERIOD_MONTHS,
      period,
    )
  ) {
    return period;
  }

  return "recent_6m";
}

/**
 * 將 Date 轉為民國年月。
 */
function toMinguoParts(date) {
  const year =
    date.getFullYear() -
    TW_YEAR_OFFSET;

  const month =
    date.getMonth() + 1;

  return {
    year: String(year),
    month: String(month),
    display:
      `${year}/${String(month).padStart(2, "0")}`,
  };
}

/**
 * 依 period 代碼動態計算起訖年月。
 *
 * 計算規則：
 *
 * 起始月份 = 當月往前推 months - 1 個月
 * 結束月份 = 當月
 *
 * 例如執行月份為民國115年7月：
 *
 * recent_6m：
 * 115/02～115/07，共6個月份
 *
 * recent_1y：
 * 114/08～115/07，共12個月份
 */
function computePeriodRange(
  period = "recent_6m",
  now = new Date(),
) {
  const normalizedPeriod =
    normalizePeriod(period);

  const months =
    PERIOD_MONTHS[
      normalizedPeriod
    ];

  /**
   * 固定使用每月1日建立日期，
   * 避免31日往前推月份時發生日期溢位。
   */
  const endDate = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
  );

  const startDate = new Date(
    now.getFullYear(),
    now.getMonth() -
      (months - 1),
    1,
  );

  const start =
    toMinguoParts(startDate);

  const end =
    toMinguoParts(endDate);

  return {
    /**
     * 提供給 lvr-client.js。
     *
     * lvr-client.js 偵測到這四個欄位後，
     * 會直接使用這裡計算的年月，
     * 確保實際填表期間與回報期間一致。
     */
    startYear:
      start.year,

    startMonth:
      start.month,

    endYear:
      end.year,

    endMonth:
      end.month,

    /**
     * 提供輸出報告使用。
     */
    startMinguo:
      start.display,

    endMinguo:
      end.display,

    period:
      normalizedPeriod,

    months,
  };
}

/**
 * 將期間代碼轉為中文。
 */
function formatPeriodLabel(period) {
  switch (period) {
    case "recent_1y":
      return "最近1年";

    case "recent_2y":
      return "最近2年";

    case "recent_5y":
      return "最近5年";

    case "recent_6m":
    default:
      return "最近6個月";
  }
}

/**
 * 依 references/query-flow.md 的放寬順序，
 * 逐步嘗試查詢，直到取得資料或所有選項耗盡。
 */
async function queryWithRelaxation(
  criteria,
  opts = {},
) {
  const queryOnce =
    opts.queryOnce ??
    await loadQueryOnce();

  const adjustments = [];

  const initialPeriod =
    normalizePeriod(
      criteria.period ??
        "recent_6m",
    );

  let working = {
    ...criteria,
    period: initialPeriod,
  };

  const relaxationSteps = [];

  /**
   * Step 0：
   * 原始條件。
   */
  relaxationSteps.push({
    label:
      "原始查詢條件（含完整門牌）",

    apply: (current) =>
      current,
  });

  /**
   * Step 1：
   * 移除門牌，只保留路段。
   */
  if (criteria.number) {
    relaxationSteps.push({
      label:
        "移除門牌，改用路段查詢",

      apply: (current) => ({
        ...current,
        number: null,
      }),
    });
  }

  /**
   * Step 2：
   * 移除段、巷、弄，只留路名。
   */
  if (
    criteria.section ||
    criteria.lane ||
    criteria.alley
  ) {
    relaxationSteps.push({
      label:
        "移除路段／巷弄，只留路名",

      apply: (current) => ({
        ...current,
        section: null,
        lane: null,
        alley: null,
        number: null,
      }),
    });
  }

  /**
   * Step 3～5：
   * 逐步擴大交易期間。
   */
  const startIndex =
    PERIOD_ESCALATION.indexOf(
      initialPeriod,
    );

  for (
    let index =
      startIndex + 1;
    index <
    PERIOD_ESCALATION.length;
    index += 1
  ) {
    const nextPeriod =
      PERIOD_ESCALATION[index];

    relaxationSteps.push({
      label:
        `擴大查詢期間為 ${formatPeriodLabel(nextPeriod)}`,

      apply: (current) => ({
        ...current,
        period: nextPeriod,
      }),
    });
  }

  /**
   * 最後一步：
   * 移除過窄的額外限制。
   */
  relaxationSteps.push({
    label:
      "移除面積、屋齡與建物型態限制",

    apply: (current) => ({
      ...current,
      areaRange: null,
      ageRange: null,
      propertyTypes: [],
    }),
  });

  let lastError = null;

  for (
    const step
    of relaxationSteps
  ) {
    working =
      step.apply(working);

    const rangeInfo =
      computePeriodRange(
        working.period ??
          "recent_6m",
      );

    /**
     * 將 startYear、startMonth、
     * endYear、endMonth 一併傳入。
     *
     * 這樣 lvr-client.js 會使用相同期間，
     * 不會重新產生不同的日期區間。
     */
    const queryCriteria = {
      ...working,
      ...rangeInfo,
    };

    const result =
      await queryOnce(
        queryCriteria,
        opts,
      );

    if (
      result.success &&
      Array.isArray(
        result.records,
      ) &&
      result.records.length > 0
    ) {
      if (
        step.label !==
        "原始查詢條件（含完整門牌）"
      ) {
        adjustments.push(
          step.label,
        );
      }

      return {
        success: true,

        records:
          result.records,

        adjustments,

        finalCriteria:
          working,

        /**
         * 輸出完整期間，
         * 包含實際傳入表單的年月。
         */
        periodRange:
          rangeInfo,
      };
    }

    /**
     * 技術性錯誤：
     * 不繼續放寬條件。
     */
    if (!result.success) {
      lastError =
        result.error;

      return {
        success: false,

        error:
          result.error,

        adjustments,

        finalCriteria:
          working,

        periodRange:
          rangeInfo,
      };
    }

    /**
     * 查詢成功但0筆：
     * 記錄這次嘗試並繼續。
     */
    adjustments.push(
      `${step.label}（仍查無資料）`,
    );
  }

  return {
    success: false,

    error:
      lastError ||
      "已嘗試所有放寬條件（門牌→路段→路名、擴大至最近5年、移除面積／屋齡／型態限制），仍查無成交資料。",

    adjustments,

    finalCriteria:
      working,

    periodRange:
      computePeriodRange(
        working.period ??
          "recent_6m",
      ),
  };
}

async function main() {
  const args =
    process.argv.slice(2);

  const jsonIndex =
    args.indexOf("--json");

  const jsonFileIndex =
    args.indexOf(
      "--json-file",
    );

  const inspect =
    args.includes("--inspect");

  let rawJson;

  if (
    jsonFileIndex !== -1 &&
    args[
      jsonFileIndex + 1
    ]
  ) {
    const fs =
      await import("node:fs");

    try {
      rawJson =
        fs
          .readFileSync(
            args[
              jsonFileIndex + 1
            ],
            "utf8",
          )
          .replace(
            /^\uFEFF/,
            "",
          );
    } catch (error) {
      console.error(
        JSON.stringify({
          error:
            `讀取 --json-file 檔案失敗：${error.message}`,
        }),
      );

      process.exit(1);
    }
  } else if (
    jsonIndex !== -1 &&
    args[jsonIndex + 1]
  ) {
    rawJson =
      args[
        jsonIndex + 1
      ].replace(
        /^\uFEFF/,
        "",
      );
  } else {
    console.error(
      JSON.stringify({
        error:
          "缺少查詢條件，請用 --json '<JSON字串>' 或 --json-file <檔案路徑>",
      }),
    );

    process.exit(1);
  }

  let criteria;

  try {
    criteria =
      JSON.parse(rawJson);
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          `查詢條件不是合法 JSON：${error.message}`,
      }),
    );

    process.exit(1);
  }

  if (
    !criteria.cityCode &&
    !criteria.community
  ) {
    console.log(
      JSON.stringify(
        {
          success: false,

          error:
            "缺少縣市代碼且未提供社區名稱，請先向使用者確認縣市與行政區，不可自行猜測。",
        },
        null,
        2,
      ),
    );

    process.exit(0);
  }

  if (inspect) {
    const queryOnce =
      await loadQueryOnce();

    const result =
      await queryOnce(
        criteria,
        {
          inspectOnly: true,
        },
      );

    console.log(
      JSON.stringify(
        result,
        null,
        2,
      ),
    );

    return;
  }

  const result =
    await queryWithRelaxation(
      criteria,
    );

  writeRawResult(result);

  console.log(
    JSON.stringify(
      result,
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
  main().catch(
    (error) => {
      console.log(
        JSON.stringify(
          {
            success: false,

            error:
              `未預期的錯誤：${error.message}`,
          },
          null,
          2,
        ),
      );

      process.exit(1);
    },
  );
}

export {
  computePeriodRange,
  formatPeriodLabel,
  normalizePeriod,
  queryWithRelaxation,
  todayMinguo,
  writeRawResult,
};

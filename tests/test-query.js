#!/usr/bin/env node

import assert from "node:assert/strict";

import {
  analyze,
  enrichRecord,
} from "../scripts/analyze-transactions.js";
import {
  computePeriodRange,
  normalizePeriod,
  queryWithRelaxation,
} from "../scripts/query-lvr.js";
import {
  parse,
} from "../scripts/parse-address.js";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`✗ ${name}`);
    console.error(`  ${error.stack ?? error.message}`);
    failed += 1;
  }
}

function record(overrides = {}) {
  return {
    id: "normal",
    a: "新北市中和區秀朗路三段",
    bn: "測試社區",
    b: "公寓(5樓含以下無電梯)",
    e: "115/06/01",
    g: "40",
    r: "99",
    s: "30",
    p: "500000",
    tp: "15000000",
    unit: "2",
    punit: "1",
    tunit: "1",
    pu: "住家用",
    t: "房地(土地+建物)",
    f: "三層/五層",
    v: "3房2廳2衛",
    note: "",
    ...overrides,
  };
}

await test("完整地址解析", () => {
  const result = parse(
    "幫我查新北市中和區秀朗路三段最近半年的成交行情",
  );

  assert.equal(result.city, "新北市");
  assert.equal(result.cityCode, "F");
  assert.equal(result.district, "中和區");
  assert.equal(result.road, "秀朗路");
  assert.equal(result.section, "三段");
  assert.equal(result.period, "recent_6m");
  assert.deepEqual(result.needsClarification, []);
});

await test("花蓮市可對應花蓮縣與花蓮市", () => {
  const result = parse(
    "花蓮市中山路100號附近房價多少",
  );

  assert.equal(result.city, "花蓮縣");
  assert.equal(result.cityCode, "U");
  assert.equal(result.district, "花蓮市");
  assert.equal(result.road, "中山路");
  assert.equal(result.number, "100號");
});

await test("缺少縣市時要求補充，不猜測地點", () => {
  const result = parse(
    "中山路100號附近房價多少",
  );

  assert.equal(result.city, null);
  assert.ok(result.needsClarification.length > 0);
});

await test("可解析社區、建物型態、租賃與車位條件", () => {
  const community = parse(
    "國泰花園住宅大樓最近成交一坪多少，有車位",
  );
  const rent = parse(
    "幫我查最近租金行情，新北市板橋區文化路",
  );

  assert.equal(community.community, "國泰花園");
  assert.ok(community.propertyTypes.includes("住宅大樓"));
  assert.equal(community.hasParking, true);
  assert.equal(rent.queryType, "rent");
});

await test("最近六個月包含執行當月在內共六個月份", () => {
  const result = computePeriodRange(
    "recent_6m",
    new Date(2026, 6, 22),
  );

  assert.equal(result.period, "recent_6m");
  assert.equal(result.months, 6);
  assert.equal(result.startMinguo, "115/02");
  assert.equal(result.endMinguo, "115/07");
});

await test("未知期間代碼回復為最近六個月", () => {
  assert.equal(
    normalizePeriod("unknown"),
    "recent_6m",
  );
});

await test("unit=2 不重複換算坪數與每坪單價", () => {
  const result = enrichRecord(record());

  assert.equal(result._areaPing, 30);
  assert.equal(result._pricePerPing, 500000);
  assert.equal(result._pricePerPingWan, 50);
});

await test("unit=1 正確將平方公尺換算成坪", () => {
  const result = enrichRecord(record({
    id: "sqm",
    unit: "1",
    s: "99.17355",
    p: "150000",
  }));

  assert.ok(
    Math.abs(result._areaPing - 30) < 0.0001,
  );
  assert.ok(
    Math.abs(result._pricePerPing - 495867.75) < 0.01,
  );
});

await test("屋齡使用 g，不使用 r", () => {
  const result = enrichRecord(record({
    g: "40",
    r: "99",
  }));

  assert.equal(result._age, 40);
});

await test("關係人交易在嚴格與參考行情都排除", () => {
  const result = analyze([
    record(),
    record({
      id: "related",
      note: "親友、員工、共有人或其他特殊關係間之交易;",
    }),
  ], {
    road: "秀朗路三段",
    marketSegment: "住宅",
  });

  assert.equal(result.strictStats.rawCount, 2);
  assert.equal(result.strictStats.validCount, 1);
  assert.equal(result.strictStats.excludedCount, 1);
  assert.equal(result.referenceStats.validCount, 1);
  assert.ok(
    result.strictExcludedCases.some(
      (item) => item.id === "related",
    ),
  );
  assert.ok(
    result.referenceExcludedCases.some(
      (item) => item.id === "related",
    ),
  );
});

await test("一般增建：嚴格排除、參考納入", () => {
  const result = analyze([
    record(),
    record({
      id: "mild-addition",
      note: "陽台外推;",
    }),
  ], null);

  assert.equal(result.strictStats.validCount, 1);
  assert.equal(result.referenceStats.validCount, 2);
  assert.ok(
    result.mildAdditionReferenceCases.some(
      (item) => item.id === "mild-addition",
    ),
  );
});

await test("不同建物型態分開產生統計", () => {
  const result = analyze([
    record(),
    record({
      id: "tower",
      b: "住宅大樓(11層含以上有電梯)",
      p: "700000",
    }),
  ], null);

  assert.equal(result.strictStats.mixedBuildingTypes, true);
  assert.deepEqual(
    result.byBuildingType.strict
      .map((item) => item.buildingType)
      .sort(),
    ["住宅大樓", "公寓"].sort(),
  );
});

await test("查詢放寬可注入離線 queryOnce，不啟動瀏覽器", async () => {
  const attempts = [];
  const fakeQueryOnce = async (criteria) => {
    attempts.push({ ...criteria });

    if (attempts.length < 2) {
      return {
        success: true,
        records: [],
      };
    }

    return {
      success: true,
      records: [record()],
    };
  };

  const result = await queryWithRelaxation({
    city: "新北市",
    cityCode: "F",
    district: "中和區",
    road: "秀朗路",
    section: "三段",
    number: "100號",
    period: "recent_6m",
  }, {
    queryOnce: fakeQueryOnce,
  });

  assert.equal(result.success, true);
  assert.equal(result.records.length, 1);
  assert.equal(attempts.length, 2);
  assert.ok(result.adjustments.length > 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;

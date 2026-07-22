#!/usr/bin/env node
/**
 * lvr-client.js
 *
 * 使用 Playwright 開啟內政部不動產交易實價查詢服務網，
 * 填寫首頁中的買賣查詢表單。
 *
 * 重要限制：
 * 官網目前會檢查 window.navigator.webdriver。
 * 若偵測到 WebDriver，搜尋事件會直接 return，
 * 因此 Playwright 無法完成最後的搜尋。
 *
 * 本程式已整合 playwright-extra 與 stealth 插件，
 * 並透過 init script 雙重防禦，確保成功搜尋。
 */

import { chromium } from "playwright-extra";
import stealthPlugin from "puppeteer-extra-plugin-stealth";

// 啟用 Stealth 插件，這會自動抹除大部分的自動化瀏覽器特徵
chromium.use(stealthPlugin());

const BASE_URL = "https://lvr.land.moi.gov.tw/";
const QUERY_PAGE = BASE_URL;
const QUERY_FRAME_URL_PART = "/jsp/index.jsp";

const SELECTORS = {
  form: "#main_form",

  city: "#p_city",
  district: "#p_town",
  addressOrCommunity: "#p_build",

  startYear: "#p_startY",
  startMonth: "#p_startM",
  endYear: "#p_endY",
  endMonth: "#p_endM",

  houseAndLand: "#customCheck1",
  landOnly: "#customCheck2",
  buildingOnly: "#customCheck3",
  parkingOnly: "#customCheck4",

  queryType: "#qryType",

  search:
    '#main_form .form-button[go_type="list"]',
};

/**
 * 將西元年轉成民國年。
 */
function normalizeRocYear(year) {
  const numericYear = Number(year);

  if (!Number.isInteger(numericYear)) {
    throw new Error(`年份格式錯誤：${year}`);
  }

  return String(
    numericYear > 1911
      ? numericYear - 1911
      : numericYear,
  );
}

/**
 * 將月份正規化為 1～12 的字串。
 */
function normalizeMonth(month) {
  const numericMonth = Number(month);

  if (
    !Number.isInteger(numericMonth) ||
    numericMonth < 1 ||
    numericMonth > 12
  ) {
    throw new Error(`月份格式錯誤：${month}`);
  }

  return String(numericMonth);
}

/**
 * 解析 recent_6m、recent_12m 等期間。
 */
function parsePeriodMonths(criteria = {}) {
  const explicitMonths = Number(
    criteria.periodMonths,
  );

  if (
    Number.isInteger(explicitMonths) &&
    explicitMonths > 0
  ) {
    return explicitMonths;
  }

  if (typeof criteria.period === "string") {
    const match = criteria.period.match(
      /^recent_(\d+)m$/,
    );

    if (match) {
      return Number(match[1]);
    }
  }

  return 6;
}

/**
 * 決定實際交易期間。
 *
 * 沒有指定時，預設查詢包含本月在內的最近六個月份。
 */
function resolveDateRange(criteria = {}) {
  if (
    criteria.startYear &&
    criteria.startMonth &&
    criteria.endYear &&
    criteria.endMonth
  ) {
    return {
      startYear: normalizeRocYear(
        criteria.startYear,
      ),
      startMonth: normalizeMonth(
        criteria.startMonth,
      ),
      endYear: normalizeRocYear(
        criteria.endYear,
      ),
      endMonth: normalizeMonth(
        criteria.endMonth,
      ),
    };
  }

  if (
    criteria.dateRange?.startYear &&
    criteria.dateRange?.startMonth &&
    criteria.dateRange?.endYear &&
    criteria.dateRange?.endMonth
  ) {
    return {
      startYear: normalizeRocYear(
        criteria.dateRange.startYear,
      ),
      startMonth: normalizeMonth(
        criteria.dateRange.startMonth,
      ),
      endYear: normalizeRocYear(
        criteria.dateRange.endYear,
      ),
      endMonth: normalizeMonth(
        criteria.dateRange.endMonth,
      ),
    };
  }

  const months = parsePeriodMonths(criteria);
  const endDate = new Date();

  const startDate = new Date(
    endDate.getFullYear(),
    endDate.getMonth() - (months - 1),
    1,
  );

  return {
    startYear: normalizeRocYear(
      startDate.getFullYear(),
    ),
    startMonth: normalizeMonth(
      startDate.getMonth() + 1,
    ),
    endYear: normalizeRocYear(
      endDate.getFullYear(),
    ),
    endMonth: normalizeMonth(
      endDate.getMonth() + 1,
    ),
  };
}

/**
 * 組合道路、段、巷、弄及號碼。
 */
function buildAddressText(criteria = {}) {
  const parts = [];

  if (criteria.road) {
    parts.push(String(criteria.road).trim());
  }

  if (criteria.section) {
    parts.push(
      String(criteria.section).trim(),
    );
  }

  if (criteria.lane) {
    const lane = String(criteria.lane).trim();

    parts.push(
      lane.endsWith("巷")
        ? lane
        : `${lane}巷`,
    );
  }

  if (criteria.alley) {
    const alley = String(
      criteria.alley,
    ).trim();

    parts.push(
      alley.endsWith("弄")
        ? alley
        : `${alley}弄`,
    );
  }

  if (
    criteria.number !== null &&
    criteria.number !== undefined &&
    String(criteria.number).trim() !== ""
  ) {
    const number = String(
      criteria.number,
    ).trim();

    parts.push(
      number.endsWith("號")
        ? number
        : `${number}號`,
    );
  }

  return parts.join("");
}

/**
 * 官網的 #p_build 可填入門牌或社區名稱。
 */
function resolveSearchText(criteria = {}) {
  if (
    criteria.community !== null &&
    criteria.community !== undefined &&
    String(criteria.community).trim() !== ""
  ) {
    return String(
      criteria.community,
    ).trim();
  }

  return buildAddressText(criteria);
}

/**
 * 找出首頁中的 index.jsp frame。
 */
async function waitForQueryFrame(
  page,
  timeoutMs,
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const queryFrame = page
      .frames()
      .find((frame) =>
        frame
          .url()
          .toLowerCase()
          .includes(
            QUERY_FRAME_URL_PART.toLowerCase(),
          ),
      );

    if (queryFrame) {
      return queryFrame;
    }

    await page.waitForTimeout(200);
  }

  const frames = page.frames().map(
    (frame) => ({
      name: frame.name(),
      url: frame.url(),
    }),
  );

  throw new Error(
    `找不到 ${QUERY_FRAME_URL_PART} frame。` +
      `目前 frame：${JSON.stringify(frames)}`,
  );
}

/**
 * 取得 select 的可用選項。
 */
async function getSelectOptions(locator) {
  return locator
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => ({
        value: String(
          option.value ?? "",
        ).trim(),
        label: String(
          option.textContent ?? "",
        ).trim(),
      })),
    );
}

/**
 * 以 value 或 label 選擇原生 select。
 */
async function selectNativeOption(
  locator,
  {
    value = null,
    label = null,
    fieldName = "下拉選單",
  } = {},
) {
  const options = await getSelectOptions(
    locator,
  );

  const normalizedValue =
    value === null || value === undefined
      ? null
      : String(value).trim();

  const normalizedLabel =
    label === null || label === undefined
      ? null
      : String(label).trim();

  let target = null;

  if (normalizedValue) {
    target = options.find(
      (option) =>
        option.value === normalizedValue,
    );
  }

  if (!target && normalizedLabel) {
    target = options.find(
      (option) =>
        option.label === normalizedLabel,
    );
  }

  if (!target) {
    throw new Error(
      `${fieldName}找不到指定選項。` +
        `value=${normalizedValue ?? "未提供"}，` +
        `label=${normalizedLabel ?? "未提供"}。` +
        `目前選項：${options
          .map(
            (option) =>
              `${option.label}(${option.value})`,
          )
          .join("、")}`,
    );
  }

  await locator.selectOption({
    value: target.value,
  });

  const actualValue =
    await locator.inputValue();

  if (actualValue !== target.value) {
    throw new Error(
      `${fieldName}設定失敗。` +
        `預期=${target.value}，實際=${actualValue}`,
    );
  }

  return target;
}

/**
 * 等待首頁買賣查詢表單完成載入。
 */
async function waitForSaleForm(
  queryFrame,
  timeoutMs,
) {
  await queryFrame
    .locator(SELECTORS.form)
    .waitFor({
      state: "attached",
      timeout: timeoutMs,
    });

  await queryFrame
    .locator(SELECTORS.city)
    .waitFor({
      state: "attached",
      timeout: timeoutMs,
    });

  await queryFrame.waitForFunction(
    ({ selector }) => {
      const city =
        document.querySelector(selector);

      return Boolean(
        city &&
          city.options.length > 2 &&
          Array.from(city.options).some(
            (option) =>
              option.value === "F",
          ),
      );
    },
    {
      selector: SELECTORS.city,
    },
    {
      timeout: timeoutMs,
    },
  );
}

/**
 * 選擇縣市後等待行政區載入。
 */
async function waitForDistrict(
  queryFrame,
  districtName,
  timeoutMs,
) {
  const district = queryFrame.locator(
    SELECTORS.district,
  );

  await district.waitFor({
    state: "attached",
    timeout: timeoutMs,
  });

  await queryFrame.waitForFunction(
    ({
      selector,
      expectedDistrict,
    }) => {
      const element =
        document.querySelector(selector);

      if (!element) {
        return false;
      }

      return Array.from(
        element.options,
      ).some(
        (option) =>
          String(
            option.textContent ?? "",
          ).trim() ===
          expectedDistrict,
      );
    },
    {
      selector: SELECTORS.district,
      expectedDistrict: districtName,
    },
    {
      timeout: timeoutMs,
    },
  );

  return district;
}

/**
 * 預設只選擇房地。
 */
async function setDefaultPropertyType(
  queryFrame,
) {
  const houseAndLand =
    queryFrame.locator(
      SELECTORS.houseAndLand,
    );

  if (!(await houseAndLand.isChecked())) {
    await houseAndLand.check({
      force: true,
    });
  }

  for (const selector of [
    SELECTORS.landOnly,
    SELECTORS.buildingOnly,
    SELECTORS.parkingOnly,
  ]) {
    const checkbox =
      queryFrame.locator(selector);

    if (
      (await checkbox.count()) > 0 &&
      (await checkbox.isChecked())
    ) {
      await checkbox.uncheck({
        force: true,
      });
    }
  }
}

/**
 * 填寫交易期間。
 */
async function fillDateRange(
  queryFrame,
  criteria,
) {
  const range =
    resolveDateRange(criteria);

  await selectNativeOption(
    queryFrame.locator(
      SELECTORS.startYear,
    ),
    {
      value: range.startYear,
      label: range.startYear,
      fieldName: "起始年份",
    },
  );

  await selectNativeOption(
    queryFrame.locator(
      SELECTORS.startMonth,
    ),
    {
      value: range.startMonth,
      label: range.startMonth,
      fieldName: "起始月份",
    },
  );

  await selectNativeOption(
    queryFrame.locator(
      SELECTORS.endYear,
    ),
    {
      value: range.endYear,
      label: range.endYear,
      fieldName: "結束年份",
    },
  );

  await selectNativeOption(
    queryFrame.locator(
      SELECTORS.endMonth,
    ),
    {
      value: range.endMonth,
      label: range.endMonth,
      fieldName: "結束月份",
    },
  );

  return range;
}

/**
 * 找出可見的搜尋控制項。
 */
async function findSearchControl(
  queryFrame,
  timeoutMs,
) {
  const controls = queryFrame.locator(
    SELECTORS.search,
  );

  await controls.first().waitFor({
    state: "attached",
    timeout: timeoutMs,
  });

  const count = await controls.count();

  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    const control = controls.nth(index);

    if (await control.isVisible()) {
      return control;
    }
  }

  throw new Error(
    "找不到可見的搜尋控制項。",
  );
}

/**
 * 將回應中的資料陣列取出。
 */
function extractRecords(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  for (const key of [
    "data",
    "records",
    "result",
    "results",
    "list",
    "items",
  ]) {
    if (Array.isArray(payload?.[key])) {
      return payload[key];
    }
  }

  return [payload];
}

/**
 * 印出 frame 中的表單資訊。
 */
async function inspectForm(queryFrame) {
  return queryFrame.evaluate(() => {
    const city =
      document.querySelector("#p_city");

    const district =
      document.querySelector("#p_town");

    const searchControls =
      Array.from(
        document.querySelectorAll(
          '#main_form .form-button[go_type="list"]',
        ),
      );

    return {
      url: window.location.href,
      navigatorWebdriver:
        window.navigator.webdriver,
      hasMainForm: Boolean(
        document.querySelector(
          "#main_form",
        ),
      ),
      cityValue: city?.value ?? null,
      cityOptions: city
        ? Array.from(city.options).map(
            (option) => ({
              value: option.value,
              label: String(
                option.textContent ?? "",
              ).trim(),
            }),
          )
        : [],
      districtValue:
        district?.value ?? null,
      districtOptions: district
        ? Array.from(
            district.options,
          ).map((option) => ({
            value: option.value,
            label: String(
              option.textContent ?? "",
            ).trim(),
          }))
        : [],
      searchControls:
        searchControls.map(
          (element) => ({
            tag: element.tagName,
            text: String(
              element.textContent ?? "",
            ).trim(),
            visible: Boolean(
              element.offsetWidth ||
                element.offsetHeight ||
                element.getClientRects()
                  .length,
            ),
          }),
        ),
    };
  });
}

/**
 * 執行一次查詢。
 */
async function queryOnce(
  criteria,
  opts = {},
) {
  const {
    headless =
      process.env.LVR_HEADLESS !==
      "false",
    timeoutMs = 30000,
    inspectOnly = false,
  } = opts;

  let browser = null;

  try {
    // 這裡調用的 chromium 已被 playwright-extra 套用 stealth 插件
    browser = await chromium.launch({
      headless,
      slowMo: headless ? 0 : 250,
    });

    const context =
      await browser.newContext({
        locale: "zh-TW",
        timezoneId: "Asia/Taipei",
        viewport: {
          width: 1440,
          height: 1000,
        },
      });

    // 【雙重保險】：因為目標表單是在 iframe (index.jsp) 裡面載入，
    // 部分瀏覽器在 headless 模式下，Stealth 插件對 iframe 的覆蓋偶爾會漏掉。
    // 這裡強制在 Context 層級注入 init script，確保所有 frame 載入時 navigator.webdriver 皆為 undefined。
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    });

    const page =
      await context.newPage();

    await page.goto(QUERY_PAGE, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    const queryFrame =
      await waitForQueryFrame(
        page,
        timeoutMs,
      );

    await waitForSaleForm(
      queryFrame,
      timeoutMs,
    );

    if (inspectOnly) {
      return {
        success: true,
        formInfo:
          await inspectForm(queryFrame),
      };
    }

    if (
      !criteria.cityCode &&
      !criteria.city
    ) {
      throw new Error(
        "缺少縣市條件。",
      );
    }

    if (!criteria.district) {
      throw new Error(
        "缺少行政區條件。",
      );
    }

    const city =
      queryFrame.locator(
        SELECTORS.city,
      );

    await selectNativeOption(city, {
      value: criteria.cityCode,
      label: criteria.city,
      fieldName: "縣市",
    });

    const district =
      await waitForDistrict(
        queryFrame,
        criteria.district,
        timeoutMs,
      );

    await selectNativeOption(
      district,
      {
        label: criteria.district,
        fieldName: "行政區",
      },
    );

    await setDefaultPropertyType(
      queryFrame,
    );

    const searchText =
      resolveSearchText(criteria);

    if (!searchText) {
      throw new Error(
        "缺少道路、門牌或社區名稱。",
      );
    }

    await queryFrame
      .locator(
        SELECTORS.addressOrCommunity,
      )
      .fill(searchText);

    const dateRange =
      await fillDateRange(
        queryFrame,
        criteria,
      );

    const queryType =
      queryFrame.locator(
        SELECTORS.queryType,
      );

    if (
      (await queryType.count()) > 0
    ) {
      await queryType.evaluate(
        (element) => {
          element.value = "biz";
        },
      );
    }

    const automationState =
      await queryFrame.evaluate(() => ({
        webdriver:
          window.navigator.webdriver ===
          true,
      }));

    /**
     * 官網搜尋事件檢測：
     * 如果 stealth 插件與 init script 起作用，這裡的 automationState.webdriver 會是 false。
     */
    if (automationState.webdriver) {
      return {
        success: false,
        blockedBySite: true,
        prepared: true,
        error:
          "表單已完整填寫，但官網搜尋程式偵測到 " +
          "navigator.webdriver=true，並在搜尋事件中直接停止執行。" +
          "因此 Playwright 不會發出 QueryPrice 查詢。" +
          "請檢查 stealth 外掛與初始化腳本是否正常載入。",
        preparedCriteria: {
          city:
            criteria.city ?? null,
          cityCode:
            criteria.cityCode ?? null,
          district:
            criteria.district,
          searchText,
          dateRange,
        },
      };
    }

    /**
     * 正常搜尋流程：此時 webdriver 已隱藏，可以順利觸發點擊事件並撈取 API 資料。
     */
    const searchControl =
      await findSearchControl(
        queryFrame,
        timeoutMs,
      );

    const responsePromise =
      page.waitForResponse(
        (response) =>
          response
            .url()
            .toLowerCase()
            .includes(
              "/service/queryprice",
            ),
        {
          timeout: timeoutMs,
        },
      );

    await searchControl.click();

    const response =
      await responsePromise;

    if (!response.ok()) {
      throw new Error(
        `QueryPrice HTTP ${response.status()}`,
      );
    }

    const payload =
      await response.json();

    return {
      success: true,
      records:
        extractRecords(payload),
      rawResponse: payload,
      appliedCriteria: {
        city:
          criteria.city ?? null,
        cityCode:
          criteria.cityCode ?? null,
        district:
          criteria.district,
        searchText,
        dateRange,
      },
    };
  } catch (error) {
    return {
      success: false,
      error:
        `查詢過程發生例外：${error.message}`,
    };
  } finally {
    if (browser) {
      await browser.close().catch(
        () => {},
      );
    }
  }
}

export {
  queryOnce,
  inspectForm,
  SELECTORS,
  BASE_URL,
  QUERY_PAGE,
};

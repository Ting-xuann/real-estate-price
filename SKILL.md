---
name: real-estate-price
description: 查詢臺灣住宅房地實價登錄成交行情；適用於地址、社區、路段或行政區的全部成交案例、分建物型態行情、嚴格與參考行情，以及物件開價的初步比較。
version: 1.0.0
metadata:
  openclaw:
    requires:
      bins:
        - node
    emoji: "🏠"
---

# 臺灣住宅房地成交行情查詢

連線至內政部「不動產交易實價查詢服務網」，取得本次即時查詢的住宅房地買賣成交資料，完成資料正規化、特殊交易辨識、增建分級、建物型態分組及繁體中文行情報告。

最終報告除行情統計外，必須列出本次查詢取得的全部成交案例，包括納入行情與遭排除的案例。

## 適用範圍

處理：

- 住宅房地買賣成交行情
- 特定地址、門牌或附近成交行情
- 特定社區成交行情
- 特定路段或行政區住宅行情
- 公寓、華廈、住宅大樓、透天厝及套房行情
- 全部實價登錄成交案例整理
- 物件開價與附近成交行情的初步比較

不處理：

- 純土地或純車位交易
- 租賃行情
- 店面或辦公室專案估價
- 正式不動產估價
- 土地增值稅、土地登記或都市更新權利變換
- 仲介書信、廣告或銷售文案

遇到超出範圍的要求時，清楚說明限制，不得以住宅房地查詢結果替代。

## 執行環境

需要：

- Node.js 20 或以上版本
- npm dependencies
- Playwright Chromium
- `playwright-extra`
- `puppeteer-extra-plugin-stealth`
- 網路連線與檔案讀寫能力

如果環境缺少必要工具、瀏覽器、相依套件或權限，明確回報技術原因，不得描述成「查無成交資料」。若環境支援權限核准流程，直接提出完成查詢所必要的核准要求。

## 路徑規則

以 `{baseDir}` 表示本 Skill 根目錄。所有程式與參考文件都必須使用 `{baseDir}` 定位，不得依賴 Agent 當下的工作目錄，也不得硬編碼使用者電腦的絕對路徑。

```text
{baseDir}/SKILL.md
{baseDir}/package.json
{baseDir}/scripts/query-lvr.js
{baseDir}/scripts/lvr-client.js
{baseDir}/scripts/analyze-transactions.js
{baseDir}/scripts/parse-address.js
{baseDir}/references/query-flow.md
{baseDir}/references/api-fields.md
{baseDir}/references/comparison-rules.md
{baseDir}/references/output-format.md
```

查詢與分析程式會在需要時自動建立：

```text
{baseDir}/debug/raw.json
{baseDir}/debug/analysis.json
```

不得要求 Skill 套件預先包含查詢結果或除錯輸出。

## Agent 執行責任

收到實價登錄行情問題時，自行完成查詢、驗證、分析及回覆，不得要求使用者手動執行 PowerShell、Node.js 或瀏覽器操作。

必要流程：

1. 解析使用者提供的地點與查詢需求。
2. 確認縣市及行政區足以辨識；資訊不足時要求補充，不得猜測。
3. 按任務需要讀取相關 reference。
4. 執行本次即時實價登錄查詢。
5. 重新讀取並驗證本次產生的 `raw.json`。
6. 確認實際查詢期間、最終條件與調整紀錄。
7. 僅在查詢成功且存在成交紀錄時執行分析。
8. 重新讀取並驗證本次產生的 `analysis.json`。
9. 依分析結果產生繁體中文行情報告。
10. 列出本次查詢取得的全部成交案例。
11. 核對明細筆數等於原始成交紀錄筆數，且每筆只出現一次。

任一步驟未完成時，不得宣告查詢任務完成。

## 解析使用者輸入

將自然語言解析為可用條件，包括：

- 縣市及縣市代碼
- 行政區
- 路名、路段、巷、弄及門牌
- 社區名稱
- 交易期間
- 建物型態
- 面積、屋齡及樓層
- 車位條件
- 開價或總價
- 其他目標物件資訊

需要時執行：

```bash
node "{baseDir}/scripts/parse-address.js" "<使用者輸入>"
```

只提供「中山路 100 號」等無法確認縣市及行政區的地址時，要求補充必要資訊。若缺少欄位不影響基本查詢，可使用既定預設值，但必須在報告中說明。

判斷物件開價時，盡量取得建物型態、面積、屋齡、樓層、車位、社區名稱及開價。資料不足時只能提供初步比較。

## 即時查詢

執行：

```bash
node "{baseDir}/scripts/query-lvr.js" --json "<query-json>"
```

範例：

```json
{
  "cityCode": "F",
  "city": "新北市",
  "district": "中和區",
  "road": "秀朗路",
  "section": "三段",
  "period": "recent_6m"
}
```

查詢程式使用 Playwright、`playwright-extra` 與 stealth 外掛驅動 Chromium，並將本次完整結果寫入 `{baseDir}/debug/raw.json`。

按需讀取完整流程：

```text
{baseDir}/references/query-flow.md
```

不得使用先前留下的 `raw.json` 代替本次查詢。

## 預設期間與條件放寬

使用者未指定期間時，預設查詢包含執行當月在內的最近六個月份：

```text
起始月份 = 當月往前推 5 個月
結束月份 = 當月
```

查詢後必須從實際輸出確認：

- `periodRange.startMinguo`
- `periodRange.endMinguo`
- `periodRange.period`
- `periodRange.months`

不得只根據期間代碼推測實際年月。

只有查詢在技術上成功且 `records` 為空陣列時，才依 `query-flow.md` 逐步放寬條件。不得一開始就查詢最近五年。

若原始條件已取得至少一筆成交資料，不得只因有效比較案例少而自行擴大地址或期間。先完成分析並揭露樣本限制；只有使用者明確要求時才進行新查詢。

## 驗證查詢結果

至少確認：

- `success === true`
- `records` 是陣列
- `records.length > 0`
- `periodRange` 符合本次要求
- `finalCriteria` 是本次最終條件
- `adjustments` 是本次調整紀錄
- `raw.json` 是本次查詢新產生的檔案

任一條件不成立時，不得產生行情數字。

若查詢在技術上成功但沒有紀錄，依 `query-flow.md` 執行允許的條件放寬。若 `success === false`，停止分析並回報實際錯誤欄位，例如：

- `error`
- `blockedBySite`
- `manualActionRequired`
- `debugFiles`
- `adjustments`
- `finalCriteria`
- `periodRange`

## 執行與驗證分析

只有查詢成功且 `records.length > 0` 時執行：

```bash
node "{baseDir}/scripts/analyze-transactions.js" --input "{baseDir}/debug/raw.json" --target "<target-json>"
```

基本 target：

```json
{
  "road": "秀朗路三段",
  "marketSegment": "住宅"
}
```

依使用者提供的資訊加入 `buildingType`、`community`、`address`、`areaPing`、`age` 或 `hasParking`。`--target` 必須是合法 JSON，且依本次查詢動態產生。

分析程式將結果寫入 `{baseDir}/debug/analysis.json`。產生報告前確認：

- `analysis.success === true`
- `analysis.json` 是本次分析新產生的檔案

分析失敗時停止產生行情報告，忠實回報錯誤，不得自行計算、補寫行情數字或改用舊分析結果。

## 技術錯誤處理

下列情況屬於技術錯誤，而非查無資料：

- Node.js 或相依套件未安裝
- Playwright、Chromium 或 stealth 外掛未安裝或載入失敗
- 執行環境沒有網路或檔案權限
- 官網暫時無回應
- session 建立失敗
- 官網表單、DOM、selector 或回應格式改版
- 網站中止自動化操作
- 查詢條件或期間不合法
- 等待官網回應逾時
- JSON 解析失敗
- 結果檔案不是本次產生
- 分析程式執行失敗

發生技術錯誤時：

1. 停止後續分析或報告。
2. 不產生任何行情數字。
3. 不使用模型記憶、訓練資料或舊資料。
4. 不使用先前留下的 JSON。
5. 不虛構、模擬或補寫成交案例。
6. 忠實回報實際錯誤。
7. 不將技術錯誤描述成查無成交資料。

## 核心資料原則

1. 只能根據本次實際查詢及分析結果回答。
2. 不得使用模型記憶、訓練資料、舊房價或先前查詢結果代替。
3. 不得虛構、模擬、推測或補寫不存在的成交案例。
4. 每次採單筆、低頻方式查詢，不進行大量、併發或持續性存取。
5. 官網連線、表單、selector 或 API 發生錯誤時，忠實回報。
6. 不同建物型態不得混合成單一代表行情。
7. 行情代表值優先使用中位數，不得只使用平均值。
8. 嚴格行情與參考行情必須分開呈現。
9. 被排除的特殊案例仍須列入全部成交案例明細。
10. 官網隱碼地址不得自行補寫。
11. 所有結果均為市場資料整理，不是正式不動產估價。

## 欄位與單位

按需讀取：

```text
{baseDir}/references/api-fields.md
```

優先使用分析程式產生的正規化欄位：

- `_areaPing`
- `_pricePerPing`
- `_pricePerPingWan`
- `_age`
- `_hardFlags`
- `_additionSeverity`
- `_additionKeywords`
- `_exclusionReasons`

不得重新換算已正規化數值，也不得自行覆寫分析程式的分類結果。屋齡使用 `g` 與 `_age`，不得把 `r` 當作屋齡。

## 建物型態與比較規則

按需讀取：

```text
{baseDir}/references/comparison-rules.md
```

至少分開整理公寓、華廈、住宅大樓、透天厝及套房。當 `mixedBuildingTypes === true` 時，不得把頂層整體平均值或中位數當作代表行情。

正式判讀優先使用：

- `strictStats`
- `strictComparableCases`
- `strictExcludedCases`
- `byBuildingType.strict`

補充判讀使用：

- `referenceStats`
- `referenceComparableCases`
- `referenceExcludedCases`
- `byBuildingType.reference`
- `mildAdditionReferenceCases`

所有特殊交易、增建分級、納入狀態與排除理由都以分析程式本次輸出為準。

## 輸出要求

產生報告前讀取：

```text
{baseDir}/references/output-format.md
```

報告至少包含：

1. 查詢資訊
2. 分建物型態行情
3. 嚴格行情與參考行情差異
4. 排除原因
5. 一般增建案例
6. 全部成交案例明細
7. 行情判讀
8. 查詢調整紀錄
9. 資料來源
10. 固定提醒

單價統一使用「萬元／坪」。缺少欄位使用 `—`，不得猜測。

## 全部案例要求

最終報告必須列出本次 `raw.json` 中的全部原始成交案例，包括所有納入與排除案例。

必須遵守：

- 明細筆數等於 `raw.records.length`
- 每筆原始案例只出現一次
- 嚴格行情與參考行情狀態使用「納入」或「排除」
- 同一案例的所有排除原因列在同一列
- 不得省略排除案例的成交價格或基本資料
- 不得補寫被隱藏的完整門牌
- 無法唯一對應時說明資料對應限制，不得猜測

案例對應優先使用原始索引或唯一識別欄位。沒有唯一識別欄位時，組合比對地址、成交日期、建物型態、面積、成交總價與成交單價。

表格結束後核對並寫明：

```text
本次原始成交共 X 筆，以上已列出 X 筆，無省略案例。
```

若明細筆數與 `raw.records.length` 不一致，不得宣告報告完成。

## 資料來源與固定提醒

資料來源：

```text
內政部不動產交易實價查詢服務網
https://lvr.land.moi.gov.tw/
查詢日期：依實際執行日期
```

報告結尾固定加入：

```text
本結果是依實價登錄公開成交資料所做的市場比較，不是正式不動產估價。實際價格仍會受到樓層、朝向、採光、裝潢、屋況、車位、景觀、管理品質及特殊交易條件影響。
```

## 已知限制

- 執行環境必須安裝 Node.js、npm dependencies 及 Playwright Chromium。
- 執行環境必須允許 Node.js 與 Playwright 連線至內政部網站。
- 網路權限可能需要使用者核准。
- 官網改版可能使表單欄位、DOM 結構或回應格式失效。
- 官網暫時無回應時，查詢可能逾時。
- 地址結果可能包含同一路段不同巷弄或不同建物型態，必須進一步分析。
- 實價登錄資料不代表區域內所有不動產價格。
- 成交資料可能包含關係人、增建、租約或其他特殊條件。
- 官網回傳地址可能經過隱碼或只顯示區段，不得自行補寫。
- 即時查詢或分析失敗時，不得改用先前成功的 JSON 產生報告。
- 全部案例無法與分析結果唯一對應時，必須揭露限制，不得自行推測。

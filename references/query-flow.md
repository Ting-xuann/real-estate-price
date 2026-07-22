# 實價登錄查詢流程與條件放寬規則

本文件規範輸入解析、即時查詢、期間計算、結果驗證、條件放寬及錯誤處理。

## 查詢架構

`scripts/lvr-client.js` 使用 Playwright、`playwright-extra` 與 stealth 外掛驅動 Chromium，讓網站前端自行建立 session、token 與查詢參數，再取得本次頁面操作產生的成交資料。

不得快取或寫死 token、cookie、session 識別碼或加密後查詢參數。每次查詢必須由新的有效頁面流程取得本次資料。

## 觀察到的網站端點

網站版本可能改變；下列端點只作診斷與維護參考：

| 方法 | 端點 | 用途 |
|---|---|---|
| GET | `/jsp/setToken.jsp` | 建立或取得 session token |
| GET | `/SERVICE/CITY` | 取得縣市代碼表 |
| GET | `/SERVICE/CITY/{縣市代碼}/` | 取得鄉鎮市區代碼表 |
| GET | `/SERVICE/QueryPrice/{識別碼}?q={查詢參數}` | 回傳本次成交案例 |

不要假設端點、識別碼、token 或參數格式永久不變。官網改版時應回報技術錯誤並更新程式，不得把錯誤描述成查無資料。

## 輸入條件

從使用者問題解析：

- `cityCode` 與 `city`
- `district`
- `road`、`section`、`lane`、`alley`、`number`
- `community`
- `period`
- `buildingType`
- `areaPing`
- `age`
- `floor`
- `hasParking`
- `askingPrice`

縣市及行政區不足以辨識時，要求使用者補充，不得猜測。其餘不妨礙基本查詢的缺漏可使用既定預設值，並在報告中說明。

## 預設交易期間

使用者未指定期間時，查詢包含執行當月在內的最近六個月份：

```text
起始月份 = 當月往前推 5 個月
結束月份 = 當月
```

支援：

| 期間代碼 | 月數 |
|---|---:|
| `recent_6m` | 6 |
| `recent_1y` | 12 |
| `recent_2y` | 24 |
| `recent_5y` | 60 |

查詢後必須驗證：

- `periodRange.startMinguo`
- `periodRange.endMinguo`
- `periodRange.period`
- `periodRange.months`

不得只根據期間代碼推測實際年月。實際期間與使用者要求不一致時，停止或清楚揭露問題，不得直接產生行情結論。

## 即時查詢流程

執行：

```bash
node "{baseDir}/scripts/query-lvr.js" --json "<query-json>"
```

查詢程式應：

1. 建立 `{baseDir}/debug`（若不存在）。
2. 啟動 Chromium 並進入內政部實價登錄網站。
3. 等待頁面完成初始化。
4. 依序設定縣市、行政區、地址或社區、期間及其他條件。
5. 送出單筆、低頻查詢。
6. 取得本次官網回傳的成交資料。
7. 記錄原始條件、最終條件、實際期間及調整紀錄。
8. 將完整結果寫入 `{baseDir}/debug/raw.json`。
9. 將結構化 JSON 輸出至標準輸出，診斷訊息送至標準錯誤。

不得以先前留下的 `raw.json` 代替本次查詢。

## 查詢成功驗證

至少確認：

- `success === true`
- `records` 是陣列
- `records.length > 0`
- `periodRange` 符合本次要求
- `finalCriteria` 是本次最終條件
- `adjustments` 是本次調整紀錄
- `raw.json` 的產生或更新時間不早於本次查詢開始時間

只有全部成立時才進入分析。

## 查無資料與條件放寬

只有技術上查詢成功且 `records` 為空陣列時才放寬條件：

1. 使用原始完整條件。
2. 移除門牌，只保留路段。
3. 移除段、巷及弄，只保留路名。
4. 期間由最近六個月擴大為最近一年。
5. 再擴大為最近兩年。
6. 再擴大為最近五年。
7. 最後才依序移除面積、屋齡及建物型態限制。

不得一開始就查詢最近五年。不得在未揭露的情況下改變條件。

原始條件已取得至少一筆資料時，不得只因有效比較案例少而自行擴大地址或期間。先完成分析並揭露樣本限制；只有使用者明確要求時才進行新查詢。

即使移除建物型態作為搜尋條件，分析與報告仍必須分建物型態呈現，不得混算代表行情。

每次放寬都寫入 `adjustments`，並更新 `finalCriteria` 與 `periodRange`。沒有調整時明確記錄：

```text
本次查詢未放寬原始條件。
```

## Session 與重試

- 不沿用過期 session、token 或 cookie。
- 頁面回應錯誤、session 過期或表單重置時，重新導覽頁面並建立新 session。
- 重試必須有明確次數上限，並維持低頻存取。
- 連續重試仍失敗時停止，回傳具體技術錯誤。

## 技術錯誤

下列情況不是「查無成交資料」：

- Node.js、npm 套件、Playwright 或 Chromium 不可用
- 網路或檔案權限不足
- 官網無回應或逾時
- session 建立失敗
- 表單欄位、selector、DOM 或回應格式改版
- 網站拒絕或中止自動化操作
- 查詢條件或期間不合法
- JSON 解析失敗
- `raw.json` 不是本次產生

錯誤時輸出 `success: false`，並盡量提供：

- `error`
- `blockedBySite`
- `manualActionRequired`
- `debugFiles`
- `adjustments`
- `finalCriteria`
- `periodRange`

發生技術錯誤時停止分析，不產生行情數字，不使用舊 JSON，也不虛構案例。

## 執行分析

只有查詢成功且 `records.length > 0` 時執行：

```bash
node "{baseDir}/scripts/analyze-transactions.js" --input "{baseDir}/debug/raw.json" --target "<target-json>"
```

分析程式將結果寫入 `{baseDir}/debug/analysis.json`。驗證 `analysis.success === true`，並確認檔案不早於本次分析開始時間。驗證失敗時不得產生行情報告或使用舊分析結果。

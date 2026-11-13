# NETWORK BOMB SQUAD｜廣播風暴拆彈行動

**一個可以直接執行、全班手機同步參與的多人即時網頁遊戲。**

## 遊戲規則

- 主持人建立房間取得 6 碼房號，將畫面投影至教室。
- 同學在自己的手機開啟同一網站，輸入房號與暱稱加入。
- 主持人按「啟動拆彈競賽」，遊戲自動進行 3 關：
  1. **迴圈緊急阻斷（35 秒）**：阻斷三角形拓樸中的冗餘路徑。此關指定切斷 B—C，但 STP 實際選路依拓樸計算，不代表 B—C 一定要切。
  2. **備援搶修（40 秒）**：A—B 故障後，解除 B—C 的阻擋讓 B 恢復連通。
  3. **終極拆彈（40 秒）**：分辨 RSTP、VLAN 與 Storm Control 的差異。
- 每關每位玩家只能答一次，正確得 **500 + 剩餘完整秒數 × 10** 分，錯誤 **扣 100 分（最低 0 分）**。
- 全部在線玩家都作答時，該關提早結束；否則等計時結束。關卡結束顯示 7.5 秒解說並自動下一關。
- 主持人可以手動提前公布答案、跳關及遊戲結束後重開。
- 同房最多 **120 位玩家**；當前房間狀態與分數暫存在 Node 記憶體。伺服器重新啟動後資料會消失。

## 電腦本機測試

需要 Node.js 18 以上。

```bash
npm install
npm start
```

在瀏覽器開 `http://localhost:3000`，一個分頁當主持人，另開幾個分頁測試玩家。手機若與電腦連上同一個可互通的 Wi-Fi，可用 `http://電腦的區域網路IPv4位址:3000` 加入；電腦防火牆需允許此連線。手機上的 `localhost` 指向手機本身，不能用它連到電腦。跨網路參與才需要可公開存取的網站網址。

Windows PowerShell 若顯示 `npm.ps1` 因執行原則被封鎖，請改用 `npm.cmd install`、`npm.cmd start`，不必修改系統執行原則。

每個分頁分別保存自己的主持人或玩家身分；重新整理同一分頁可恢復房間、分數與該關已作答狀態。關閉分頁後，請重新加入。

### 本機自動測試

```bash
npm test
npm run test:browser
```

`npm test` 檢查必要檔案，並以真實 Socket.IO 連線測試建房、加入、主持權限、三關計分、重複作答限制、作答紀錄恢復與重新開始。

`npm run test:browser` 需要 Node.js 20 以上及已安裝的 Google Chrome，測試同瀏覽器多分頁、作答後重新整理，以及主持人和三位玩家的完整流程。測試會實際等待 35、40、40 秒倒數與每關 7.5 秒解說，約需 2 至 3 分鐘；同時檢查手機版畫面、排行榜、自動換關、手動跳關與重新開始。未啟動網站時，測試會自動啟動測試伺服器。Windows PowerShell 也可將命令開頭的 `npm` 改成 `npm.cmd`。

## Render 部署（新服務，約 5 個步驟）

1. 將這個資料夾所有檔案（不包含 node_modules）推到一個 GitHub repository。
2. 登入 Render，選 **New > Web Service**，連接剛才的 GitHub repo；也可以選 **New > Blueprint** 使用專案內的 `render.yaml`。
3. Runtime = `Node`，Build Command = `npm install`，Start Command = `npm start`。免費方案可用於課堂測試，但休眠喚醒及併發表現依 Render 服務現況而異。
4. 等候部署成功，開啟 Render 給你的 `https://....onrender.com` 網址。先用兩部手機實測。
5. 課堂上將網址做成 QR Code，投影主持人的代碼。

**若想沿用原有 `broadcast-storm-game.onrender.com` 網址：** 需有原 Render 服務的管理權限，在原始 GitHub repo 更新程式並重新部署。單靠這個下載檔無法直接覆蓋別人的 Render 網站。若原服務綁定不同程式架構，請先備份原專案。

## 重要技術提醒

這是**教學模擬**，沒有製造真實的網路洪泛或廣播風暴，遊戲倒數及事件是規則驅動，並非 Packet Tracer 或真實交換器逐封包計算結果。廣播風暴的原因是 Loop 中反覆轉送造成廣播流量可能失控，不應誤以為多人點擊網站本身必然產生 Layer 2 Loop。

## 專案結構

```
server.js          Express + Socket.IO，房間、計時、計分、正解驗證
public/index.html  主持人與玩家畫面
public/styles.css  響應式網頁、網路拓樸、計時與排行榜視覺
public/app.js      即時連線、操作、重連、遊戲互動
render.yaml        Render 部署設定
package.json       依賴套件與啟動命令
```

## Codex 擴充指令

> 請維持現有 Express + Socket.IO 架構與三關遊戲邏輯。替 NETWORK BOMB SQUAD 新增主持人房間分享 QR Code、自動複製加入網址、搶答音效與更清楚的網路拓樸動畫。不要修改 server.js 的正確答案與計分來源，不要在前端判斷正解或信任玩家傳回的分數。維持手機版與 Render 一鍵部署相容，並補上 Socket.IO 多人測試。

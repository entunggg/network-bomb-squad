'use strict';
const { test, expect } = require('@playwright/test');
const pendingText = '答案已提交，等待本關結束';
const scores = page => page.locator('.player .score').allTextContents();
const scoreOf = async (page, name) => Number(await page.locator('.player').filter({hasText:name}).locator('.score').textContent());
async function join(page, code, name) {
  await page.goto(`/?room=${code}`, {waitUntil:'domcontentloaded'});
  await page.locator('#nickname').fill(name); await page.locator('#joinBtn').click();
  await expect(page.locator('#roleTag')).toContainText('玩家視角');
}
async function createGame(browser, sameContext = false) {
  const hostContext = await browser.newContext();
  const playerContext = sameContext ? hostContext : await browser.newContext({viewport:{width:390,height:844}});
  // External fonts are optional; tests should also work without Google access.
  for (const context of new Set([hostContext,playerContext])) await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  const host = await hostContext.newPage(), player = await playerContext.newPage(), errors = [];
  for (const page of [host,player]) page.on('pageerror', e => errors.push(e.message));
  await host.goto('/', {waitUntil:'domcontentloaded'});
  await expect(host.locator('#connection')).toHaveClass(/online/);
  await host.locator('#createBtn').click(); await expect(host.locator('#startBtn')).toBeVisible();
  const code = await host.locator('#roomCode').textContent(); expect(code).toMatch(/^[A-Z2-9]{6}$/);
  await join(player, code, '測試玩家'); await expect(host.locator('#peopleCount')).toContainText('1 人在線');
  return {hostContext,playerContext,host,player,code,errors};
}
async function pending(page) {
  await expect(page.locator('#feedback')).toHaveText(pendingText);
  await expect(page.locator('.option').first()).toBeDisabled();
  await expect(page.locator('.option.correct, .option.wrong')).toHaveCount(0);
  await expect(page.locator('#feedback')).not.toHaveClass(/good|bad/);
}

test('same browser tabs preserve separate host and player identities', async ({browser}) => {
  const g = await createGame(browser, true);
  try {
    await g.host.reload({waitUntil:'domcontentloaded'});
    await expect(g.host.locator('#roleTag')).toContainText('主持人視角');
    await expect(g.host.locator('#startBtn')).toBeVisible();
    await g.player.reload({waitUntil:'domcontentloaded'});
    await expect(g.player.locator('#roleTag')).toContainText('玩家視角');
    await expect(g.host.locator('#peopleCount')).toContainText('1 位玩家'); expect(g.errors).toEqual([]);
  } finally { await g.hostContext.close(); }
});

test('fixed real countdowns conceal single, multiple and all early answers; restore, skip and replay work', async ({browser}) => {
  const g = await createGame(browser), {host,player} = g;
  let rival, waiting, ownScore = 0, rivalScore = 0;
  try {
    await host.locator('#startBtn').click();
    for (let round = 0; round < 3; round++) {
      await expect(host.locator('#stageBadge')).toHaveText(`${round+1} / 3`, {timeout:18000});
      await expect(host.locator('#countdownLabel')).toHaveText('作答倒數');
      await expect(player.locator('.option').first()).toBeEnabled();
      const duration = round === 0 ? 35 : 40;
      const initial = Number((await host.locator('#countdown').textContent()).split(':')[1]);
      expect(initial).toBeGreaterThanOrEqual(duration-2); expect(initial).toBeLessThanOrEqual(duration);
      const observedAt = Date.now();
      const beforeScores = await scores(host);
      await player.locator('.option').nth([1,1,2][round]).click(); await pending(player);
      if (rival) {
        await rival.locator('.option').nth(0).click(); await pending(rival);
        if (round === 1) { await waiting.locator('.option').nth(0).click(); await pending(waiting); }
      }
      await expect(host.locator('.player .score')).toHaveText(beforeScores);
      await expect(host.locator('#countdownLabel')).toHaveText('作答倒數');
      if (round === 0) {
        // This is the only player and has already answered. A reload must stay private and locked.
        await player.reload({waitUntil:'domcontentloaded'}); await pending(player);
        expect(await scoreOf(player, '測試玩家')).toBe(0);
        await player.screenshot({path:'test-results/submitted-mobile.png',fullPage:true});
      }
      if (round === 1) {
        await expect(host.locator('.player small')).toHaveText([/已提交/,/已提交/,/已提交/]);
        await g.playerContext.setOffline(true);
        await expect(player.locator('#connection')).not.toHaveClass(/online/);
        await g.playerContext.setOffline(false);
        await expect(player.locator('#connection')).toHaveClass(/online/, {timeout:12000});
        await pending(player);
        expect(await scoreOf(player, '測試玩家')).toBe(ownScore);
      }
      await expect(host.locator('#countdownLabel')).toHaveText('解說倒數', {timeout:(duration+3)*1000});
      expect(Date.now()-observedAt).toBeGreaterThanOrEqual((duration-2)*1000);
      const revealAt = Date.now();
      const explanationSeconds = Number((await host.locator('#countdown').textContent()).split(':')[1]);
      expect(explanationSeconds).toBeGreaterThanOrEqual(14); expect(explanationSeconds).toBeLessThanOrEqual(15);
      await expect(player.locator('#feedback')).toContainText(round === 1 ? '操作失敗' : '拆彈成功');
      await expect(player.locator('.option.correct')).toHaveCount(1);
      const newOwn = await scoreOf(host, '測試玩家');
      if (round === 1) expect(newOwn).toBe(ownScore-100);
      else { expect(newOwn-ownScore).toBeGreaterThanOrEqual(500); expect(newOwn-ownScore).toBeLessThanOrEqual(500+duration*10); }
      ownScore = newOwn;
      if (rival) {
        const newRival = await scoreOf(host, '競爭玩家');
        if (round === 1) expect(newRival-rivalScore).toBeGreaterThanOrEqual(500);
        else expect(newRival).toBe(Math.max(0,rivalScore-100));
        rivalScore = newRival;
        if (round === 2) await expect(waiting.locator('#feedback')).toContainText('本關未作答');
      }
      const ranked = (await scores(host)).map(Number); expect(ranked).toEqual([...ranked].sort((a,b) => b-a));
      if (round === 0) {
        await player.reload({waitUntil:'domcontentloaded'});
        await expect(player.locator('#feedback')).toContainText('拆彈成功');
        expect(await scoreOf(player, '測試玩家')).toBe(ownScore);
        rival = await g.hostContext.newPage(); waiting = await g.hostContext.newPage();
        for (const page of [rival,waiting]) page.on('pageerror', e => g.errors.push(e.message));
        await join(rival, g.code, '競爭玩家'); await join(waiting, g.code, '逾時玩家');
        await expect(host.locator('#peopleCount')).toContainText('3 人在線');
      }
      if (round < 2) await expect(host.locator('#countdownLabel')).toHaveText('作答倒數', {timeout:18000});
      else await expect(host.locator('#stageBadge')).toHaveText('COMPLETE', {timeout:18000});
      expect(Date.now()-revealAt).toBeGreaterThanOrEqual(14000);
    }
    await expect(player.locator('#gameTitle')).toContainText('拆彈任務結束');
    await expect(host.locator('#countdown')).toHaveText('00:00');
    expect(await scoreOf(player, '測試玩家')).toBe(ownScore);
    expect(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await host.screenshot({path:'test-results/final-leaderboard.png',fullPage:true});
    await player.screenshot({path:'test-results/mobile-final.png',fullPage:true});
    await host.locator('#resetBtn').click();
    await expect(host.locator('#stageBadge')).toHaveText('LOBBY');
    await expect(host.locator('.player .score')).toHaveText(['0','0','0']);
    await expect(player.locator('#feedback')).toBeHidden();
    await host.locator('#startBtn').click();
    await player.locator('.option').nth(1).click(); await pending(player);
    await expect(host.locator('.player .score')).toHaveText(['0','0','0']);
    await host.locator('#nextBtn').click();
    await expect(host.locator('#countdownLabel')).toHaveText('解說倒數');
    await expect(player.locator('#feedback')).toContainText('拆彈成功');
    for (let round = 1; round < 3; round++) {
      await host.locator('#nextBtn').click();
      await expect(host.locator('#stageBadge')).toHaveText(`${round+1} / 3`);
      await expect(player.locator('.option').first()).toBeEnabled();
      await host.locator('#nextBtn').click();
      await expect(host.locator('#countdownLabel')).toHaveText('解說倒數');
    }
    await host.locator('#nextBtn').click(); await expect(host.locator('#stageBadge')).toHaveText('COMPLETE');
    await host.locator('#resetBtn').click(); await expect(host.locator('.player .score')).toHaveText(['0','0','0']);
    expect(g.errors).toEqual([]);
  } finally { await g.hostContext.close(); await g.playerContext.close(); }
});

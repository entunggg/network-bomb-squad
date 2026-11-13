'use strict';
const { test, expect } = require('@playwright/test');

async function createGame(browser, { sameContext = false } = {}) {
  const hostContext = await browser.newContext();
  const playerContext = sameContext ? hostContext : await browser.newContext({ viewport: { width: 390, height: 844 } });
  const host = await hostContext.newPage();
  const player = await playerContext.newPage();
  const errors = [];
  for (const page of [host, player]) page.on('pageerror', e => errors.push(e.message));
  await host.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(host.locator('#connection')).toHaveClass(/online/);
  await host.locator('#createBtn').click();
  await expect(host.locator('#startBtn')).toBeVisible();
  const code = await host.locator('#roomCode').textContent();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  await player.goto(`/?room=${code}`, { waitUntil: 'domcontentloaded' });
  await player.locator('#nickname').fill('測試玩家');
  await player.locator('#joinBtn').click();
  await expect(host.locator('#peopleCount')).toContainText('1 人在線');
  return { hostContext, playerContext, host, player, errors };
}

test('same-browser tabs keep host and player identities on reload', async ({ browser }) => {
  const { hostContext, host, player, errors } = await createGame(browser, { sameContext: true });
  try {
    await host.reload({ waitUntil: 'domcontentloaded' });
    await expect(host.locator('#roleTag')).toContainText('主持人視角');
    await expect(host.locator('#startBtn')).toBeVisible();
    await player.reload({ waitUntil: 'domcontentloaded' });
    await expect(player.locator('#roleTag')).toContainText('玩家視角');
    await expect(host.locator('#peopleCount')).toContainText('1 位玩家');
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); }
});

test('answered player remains locked after reload during a live round', async ({ browser }) => {
  const { hostContext, playerContext, host, player, errors } = await createGame(browser);
  const extraContext = await browser.newContext();
  const extra = await extraContext.newPage();
  try {
    // An independent waiting player keeps the round live after the first answer.
    await extra.goto('/', { waitUntil: 'domcontentloaded' });
    await extra.locator('#joinCode').fill(await host.locator('#roomCode').textContent());
    await extra.locator('#nickname').fill('等待玩家');
    await extra.locator('#joinBtn').click();
    await expect(host.locator('#peopleCount')).toContainText('2 位玩家');
    await host.locator('#startBtn').click();
    await player.locator('.option').nth(1).click();
    await expect(player.locator('#feedback')).toContainText('拆彈成功');
    const score = await player.locator('#myScore').textContent();
    await player.reload({ waitUntil: 'domcontentloaded' });
    await expect(player.locator('#feedback')).toContainText('拆彈成功');
    await expect(player.locator('.option').first()).toBeDisabled();
    await expect(player.locator('#myScore')).toHaveText(score);
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await playerContext.close(); await extraContext.close(); }
});

test('three real countdowns, automatic transitions, scoring, leaderboard and reset', async ({ browser }) => {
  const { hostContext, playerContext, host, player, errors } = await createGame(browser);
  const rival = await hostContext.newPage();
  const waiting = await hostContext.newPage();
  const scoreOf = async (page, name) => Number(await page.locator('.player').filter({ hasText: name }).locator('.score').textContent());
  try {
    const code = await host.locator('#roomCode').textContent();
    for (const [page, name] of [[rival, '競爭玩家'], [waiting, '逾時玩家']]) {
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(`/?room=${code}`, { waitUntil: 'domcontentloaded' });
      await page.locator('#nickname').fill(name);
      await page.locator('#joinBtn').click();
    }
    await expect(host.locator('#peopleCount')).toContainText('3 人在線');
    await host.locator('#startBtn').click();
    let ownScore = 0, rivalScore = 0;
    const choices = [[1, 0], [1, 0], [2, 0]];
    for (let round = 0; round < 3; round++) {
      await expect(host.locator('#stageBadge')).toHaveText(`${round + 1} / 3`, { timeout: 12000 });
      await expect(player.locator('.option').first()).toBeEnabled();
      const seconds = round === 0 ? 35 : 40;
      const initial = await host.locator('#countdown').textContent();
      expect(Number(initial.split(':')[1])).toBeGreaterThanOrEqual(seconds - 2);
      expect(Number(initial.split(':')[1])).toBeLessThanOrEqual(seconds);
      await expect.poll(async () => host.locator('#countdown').textContent()).not.toBe(initial);
      await player.locator('.option').nth(choices[round][0]).click();
      await rival.locator('.option').nth(choices[round][1]).click();
      await expect(player.locator('.option').first()).toBeDisabled();
      await expect(rival.locator('.option').first()).toBeDisabled();
      const newOwn = await scoreOf(host, '測試玩家');
      const newRival = await scoreOf(host, '競爭玩家');
      if (round === 1) {
        expect(newOwn).toBe(ownScore - 100);
        expect(newRival - rivalScore).toBeGreaterThanOrEqual(500);
      } else {
        expect(newOwn - ownScore).toBeGreaterThanOrEqual(500);
        expect(newOwn - ownScore).toBeLessThanOrEqual(500 + seconds * 10);
        expect(newRival).toBe(Math.max(0, rivalScore - 100));
      }
      ownScore = newOwn; rivalScore = newRival;
      await expect(host.locator('#networkStatus')).toHaveText('✓ 已結算', { timeout: (seconds + 2) * 1000 });
      await expect(waiting.locator('.option').first()).toBeDisabled();
      await expect(waiting.locator('.option.correct')).toHaveCount(1);
      expect(await scoreOf(host, '逾時玩家')).toBe(0);
      const ranks = await host.locator('.player .score').allTextContents();
      expect(ranks.map(Number)).toEqual([...ranks.map(Number)].sort((a, b) => b - a));
    }
    await expect(host.locator('#stageBadge')).toHaveText('COMPLETE', { timeout: 12000 });
    await expect(player.locator('#gameTitle')).toContainText('拆彈任務結束');
    await expect(host.locator('#countdown')).toHaveText('00:00');
    expect(await scoreOf(player, '測試玩家')).toBe(ownScore);
    expect(await scoreOf(player, '競爭玩家')).toBe(rivalScore);
    await host.screenshot({ path: 'test-results/final-leaderboard.png', fullPage: true });
    await player.screenshot({ path: 'test-results/mobile-final.png', fullPage: true });
    expect(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await host.locator('#resetBtn').click();
    await expect(host.locator('#stageBadge')).toHaveText('LOBBY');
    await expect(host.locator('.player .score')).toHaveText(['0', '0', '0']);
    await host.locator('#startBtn').click();
    await expect(player.locator('.option').first()).toBeEnabled();
    await host.locator('#nextBtn').click();
    await expect(host.locator('#networkStatus')).toHaveText('✓ 已結算');
    await host.locator('#nextBtn').click();
    await expect(host.locator('#stageBadge')).toHaveText('2 / 3');
    expect(errors).toEqual([]);
  } finally { await hostContext.close(); await playerContext.close(); }
});

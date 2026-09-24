import hbSDK, { HbMiniProgramSDKError } from '@heybox/hb-sdk';
import './styles.css';
import {
  CHALLENGES,
  CHALLENGE_ORDER,
  CODE_LENGTH,
  formatResult,
  formatSeconds,
  isBetterResult,
  makeResult,
} from './challenge.js';
import { formatRank, loadBoard, loadMyEntry, loadMyProfile, submitResult } from './leaderboard.js';
import { MORSE_BY_DIGIT, createMorsePlayer, randomCode } from './morse.js';
import { syncViewportInsets } from './viewport.js';

/** 密码破译线索表的展示顺序，与游戏一致：1-9 再 0。 */
const TABLE_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** 输满 3 位后短暂停留，让最后一位按键有可见反馈，再判定。 */
const VERIFY_DELAY_MS = 160;
/** 单轮结果停留时长：答对短、答错长（要看清正确答案）。 */
const WON_HOLD_MS = 620;
const LOST_HOLD_MS = 1400;

/** 本地记录 key。v2 起按模式存最好成绩，与 v1 的连续练习统计不兼容。 */
const STORAGE_KEY = 'delta-unlock-record-v2';

/** 常驻排行榜展示条数（getList 单页上限 100，50 一页够用）。 */
const BOARD_LIMIT = 50;

const dom = {
  chips: document.getElementById('chips'),
  hudProgress: document.getElementById('hud-progress'),
  hudSolved: document.getElementById('hud-solved'),
  hudTotal: document.getElementById('hud-total'),
  hudBest: document.getElementById('hud-best'),
  screen: document.getElementById('screen'),
  screenStatus: document.getElementById('screen-status'),
  screenClock: document.getElementById('screen-clock'),
  screenFoot: document.getElementById('screen-foot'),
  signals: document.getElementById('signals'),
  slots: document.getElementById('slots'),
  digitsLabel: document.getElementById('digits-label'),
  keypad: document.getElementById('keypad'),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meter-fill'),
  entry: document.querySelector('.entry'),
  actions: document.querySelector('.actions'),
  tablePanel: document.getElementById('table-panel'),
  table: document.getElementById('table'),
  result: document.getElementById('result'),
  resultEyebrow: document.getElementById('result-eyebrow'),
  resultTitle: document.getElementById('result-title'),
  resultSolved: document.getElementById('result-solved'),
  resultTotal: document.getElementById('result-total'),
  resultAverage: document.getElementById('result-average'),
  resultAccuracy: document.getElementById('result-accuracy'),
  resultRank: document.getElementById('result-rank'),
  boardPanel: document.getElementById('board-panel'),
  boardTitle: document.getElementById('board-title'),
  boardStatus: document.getElementById('board-status'),
  boardList: document.getElementById('board-list'),
  btnBoardRefresh: document.getElementById('btn-board-refresh'),
  btnMain: document.getElementById('btn-main'),
  btnAgain: document.getElementById('btn-again'),
  btnBack: document.getElementById('btn-back'),
  btnTable: document.getElementById('btn-table'),
  footStats: document.getElementById('foot-stats'),
  footNote: document.getElementById('foot-note'),
};

const state = {
  mode: 'practice',
  /** 对照表常驻显示，保留手动收起。 */
  wantsTable: true,
  /** idle | running | roundResult | practiceResult | summary */
  phase: 'idle',
  code: [],
  entry: [],
  /** 当前轮序号，1-based。 */
  round: 1,
  solved: 0,
  /** 已结束轮次的耗时（含答错与超时轮）。 */
  roundTimes: [],
  totalMs: 0,
  roundStartedAt: 0,
  roundElapsedMs: 0,
  tickId: 0,
  advanceId: 0,
  /** 单轮结算展示：{ ok, code } */
  reveal: null,
  storageFallback: false,
  /**
   * 练习模式的会话累计：只在内存里，不落 storage。
   * 离开练习模式或关闭页面就归零，符合「练习不计成绩」的定位。
   */
  practice: { decoded: 0, totalMs: 0, bestMs: 0, rounds: 0 },
  /** 各挑战模式的最好成绩与完成次数。 */
  best: {},
  plays: {},
  /** 榜单请求序号：切换难度后让在途的旧请求作废，避免旧榜单覆盖新榜单。 */
  boardToken: 0,
};

const morsePlayer = createMorsePlayer();
const signalRows = [];
const slotCells = [];

/* ------------------------------------------------------------------ 工具 */

const currentConfig = () => CHALLENGES[state.mode];
/** 是否处于「一轮在进行或刚结束」的状态：终端展示的是一轮实况而不是待机。 */
const inRunPhase = () =>
  state.phase === 'running' || state.phase === 'roundResult' || state.phase === 'practiceResult';

/** 是否正在进行中的一轮（计时还在跑）。 */
const isTiming = () => state.phase === 'running';

/** 挑战进行中的累计总用时（含当前未结束的轮）。 */
function liveTotalMs() {
  return state.totalMs + (isTiming() ? state.roundElapsedMs : 0);
}

function morseElement(morse) {
  const wrapper = document.createElement('span');
  wrapper.className = 'morse';
  for (const symbol of morse) {
    const glyph = document.createElement('span');
    glyph.className = symbol === '.' ? 'morse__dot' : 'morse__dash';
    wrapper.append(glyph);
  }
  return wrapper;
}

function setStatus(text) {
  dom.screenStatus.textContent = text;
}

function setFoot(text) {
  dom.screenFoot.textContent = text;
}

function setFootNote(text) {
  dom.footNote.textContent = text;
}

function flash(kind) {
  dom.screen.dataset.flash = kind;
  window.setTimeout(() => {
    if (dom.screen.dataset.flash === kind) {
      dom.screen.dataset.flash = '';
    }
  }, 420);
}

function setKeypadEnabled(enabled) {
  for (const key of dom.keypad.querySelectorAll('.key')) {
    key.disabled = !enabled;
  }
}

function setMainButton(label, disabled) {
  dom.btnMain.textContent = label;
  dom.btnMain.disabled = disabled;
}

function clearTimers() {
  window.clearTimeout(state.advanceId);
  window.clearInterval(state.tickId);
  state.advanceId = 0;
  state.tickId = 0;
}

async function notify(message, status) {
  try {
    await hbSDK.ui.showToast(status ? { message, status } : { message });
  } catch (error) {
    if (!(error instanceof HbMiniProgramSDKError)) {
      console.warn('[delta-unlock] showToast 失败', error);
    }
    setFoot(message);
  }
}

function vibrate(intensity) {
  // 新 PC Host 的桌面环境没有触觉反馈，会以 METHOD_FORBIDDEN 拒绝，这里静默降级。
  hbSDK.device.vibrate({ intensity }).catch(() => {});
}

/* ---------------------------------------------------------------- 本地记录 */

function normalizeRecord(value) {
  const record = { best: {}, plays: {} };
  if (!value || typeof value !== 'object') {
    return record;
  }
  for (const id of CHALLENGE_ORDER) {
    const best = value.best?.[id];
    if (best && typeof best.solved === 'number' && typeof best.totalMs === 'number') {
      record.best[id] = makeResult(best.solved, best.totalMs);
    }
    const plays = value.plays?.[id];
    if (typeof plays === 'number' && Number.isFinite(plays) && plays >= 0) {
      record.plays[id] = Math.floor(plays);
    }
  }
  return record;
}

function readLocalRecord() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function writeLocalRecord(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 浏览器预览环境可能禁用 localStorage，忽略即可。
  }
}

async function loadRecord() {
  let data;
  try {
    ({ data } = await hbSDK.storage.getStorage({ key: STORAGE_KEY }));
  } catch (error) {
    state.storageFallback = true;
    console.warn('[delta-unlock] hbSDK.storage 不可用，回退到 localStorage', error);
    data = readLocalRecord();
  }
  const record = normalizeRecord(data);
  state.best = record.best;
  state.plays = record.plays;
}

async function saveRecord() {
  const payload = { best: state.best, plays: state.plays };
  if (state.storageFallback) {
    writeLocalRecord(payload);
    return;
  }
  try {
    await hbSDK.storage.setStorage({ key: STORAGE_KEY, data: payload });
  } catch (error) {
    state.storageFallback = true;
    console.warn('[delta-unlock] hbSDK.storage 写入失败，回退到 localStorage', error);
    writeLocalRecord(payload);
  }
}

/* ------------------------------------------------------------------ 渲染 */

function buildChips() {
  for (const id of CHALLENGE_ORDER) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.dataset.mode = id;
    chip.textContent = CHALLENGES[id].chip;
    chip.setAttribute('aria-pressed', 'false');
    chip.addEventListener('click', () => selectMode(id));
    dom.chips.append(chip);
  }
}

function buildSignalRows() {
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const row = document.createElement('li');
    row.className = 'signal';

    const idx = document.createElement('span');
    idx.className = 'signal__idx';
    idx.textContent = String(index + 1).padStart(2, '0');

    const morse = document.createElement('span');
    morse.className = 'signal__morse';

    const listen = document.createElement('button');
    listen.type = 'button';
    listen.className = 'signal__listen';
    listen.textContent = '试听';
    listen.setAttribute('aria-label', `试听第 ${index + 1} 行摩斯密码`);
    listen.addEventListener('click', () => {
      if (state.code.length !== CODE_LENGTH) {
        return;
      }
      morsePlayer.play(MORSE_BY_DIGIT[state.code[index]]);
    });

    const slot = document.createElement('span');
    slot.className = 'signal__slot';

    row.append(idx, morse, listen, slot);
    dom.signals.append(row);
    signalRows.push({ row, morse, listen, slot });
  }
}

function buildSlots() {
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const cell = document.createElement('span');
    cell.className = 'slot';
    dom.slots.append(cell);
    slotCells.push(cell);
  }
}

function buildTable() {
  for (const digit of TABLE_ORDER) {
    const row = document.createElement('li');
    row.className = 'table__row';
    row.dataset.digit = digit;

    const label = document.createElement('span');
    label.className = 'table__digit';
    label.textContent = digit;

    // 与游戏一致：摩斯图案在左、数字在右。
    row.append(morseElement(MORSE_BY_DIGIT[Number(digit)]), label);
    dom.table.append(row);
  }
}

function renderChips() {
  for (const chip of dom.chips.querySelectorAll('.chip')) {
    const active = chip.dataset.mode === state.mode;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  }
}

function renderSignals() {
  const revealed = Boolean(state.reveal);

  signalRows.forEach((refs, index) => {
    const morse = state.code.length === CODE_LENGTH ? MORSE_BY_DIGIT[state.code[index]] : '-----';
    refs.morse.replaceChildren(...morseElement(morse).children);
    refs.morse.classList.toggle('is-idle', state.code.length !== CODE_LENGTH);
    refs.listen.disabled = state.code.length !== CODE_LENGTH;

    const entered = state.entry[index];
    if (revealed) {
      refs.slot.textContent = String(state.code[index]);
      refs.slot.dataset.tone = state.reveal.ok ? 'ok' : 'bad';
    } else if (entered === undefined) {
      refs.slot.textContent = '·';
      refs.slot.dataset.tone = 'empty';
    } else {
      refs.slot.textContent = String(entered);
      refs.slot.dataset.tone = 'filled';
    }
  });
}

function renderSlots() {
  const showingAnswer = Boolean(state.reveal);

  dom.digitsLabel.textContent = state.reveal
    ? state.reveal.ok
      ? 'UNLOCKED'
      : 'WRONG CODE'
    : 'PASSCODE';

  slotCells.forEach((cell, index) => {
    const value = state.entry[index];
    cell.textContent = value === undefined ? '' : String(value);
    cell.classList.toggle('is-current', state.phase === 'running' && index === state.entry.length);
    cell.classList.remove('is-ok', 'is-bad');

    if (showingAnswer) {
      cell.classList.add(state.entry[index] === state.code[index] ? 'is-ok' : 'is-bad');
    }
  });
}

function renderHud() {
  const config = currentConfig();

  dom.hudProgress.textContent = inRunPhase() ? `${state.round}/${config.rounds}` : '—';

  if (config.leaderboardKey) {
    dom.hudSolved.textContent = String(state.solved);
    dom.hudTotal.textContent = formatSeconds(liveTotalMs());
    dom.hudBest.textContent = formatResult(state.best[state.mode]);
  } else {
    // 练习：显示本次会话的累计，退出练习或关闭页面即清空。
    const { decoded, totalMs, bestMs } = state.practice;
    dom.hudSolved.textContent = String(decoded);
    dom.hudTotal.textContent = formatSeconds(totalMs);
    dom.hudBest.textContent = bestMs > 0 ? formatSeconds(bestMs) : '—';
  }

  const lines = CHALLENGE_ORDER.filter((id) => CHALLENGES[id].leaderboardKey && state.best[id]).map(
    (id) => `${CHALLENGES[id].chip} ${formatResult(state.best[id])}`,
  );
  dom.footStats.textContent = lines.length > 0 ? `最好成绩：${lines.join(' · ')}` : '还没有挑战记录';

  if (state.storageFallback) {
    setFootNote('浏览器预览环境：记录保存在本地 localStorage');
  }
}

function renderMeter() {
  const config = currentConfig();
  const visible = config.limitMs > 0 && inRunPhase();
  dom.meter.hidden = !visible;
  dom.screenClock.hidden = !visible;

  if (!visible) {
    dom.screenClock.textContent = '—';
    dom.screen.classList.remove('is-urgent');
    return;
  }

  const remaining = Math.max(0, config.limitMs - state.roundElapsedMs);
  dom.meterFill.style.transform = `scaleX(${remaining / config.limitMs})`;
  dom.screenClock.textContent = `${(remaining / 1000).toFixed(1)}s`;
  dom.screen.classList.toggle('is-urgent', remaining <= config.limitMs * 0.3);
}

function renderTableVisibility() {
  dom.tablePanel.hidden = !state.wantsTable;
  dom.btnTable.setAttribute('aria-pressed', String(state.wantsTable));
  dom.btnTable.classList.toggle('is-active', state.wantsTable);
}

function renderVisibility() {
  const summary = state.phase === 'summary';
  dom.screen.hidden = summary;
  dom.entry.hidden = summary;
  dom.actions.hidden = summary;
  dom.result.hidden = !summary;
}

function clearTableHits() {
  for (const row of dom.table.querySelectorAll('.table__row')) {
    row.classList.remove('is-hit');
  }
}

function markTableHits() {
  clearTableHits();
  for (const digit of state.code) {
    dom.table.querySelector(`.table__row[data-digit="${digit}"]`)?.classList.add('is-hit');
  }
}

function renderAll() {
  renderChips();
  renderSignals();
  renderSlots();
  renderHud();
  renderMeter();
  renderTableVisibility();
  renderVisibility();

  dom.screen.dataset.phase = state.phase;
}

/* ------------------------------------------------------------------ 计时 */

function startRoundTimer() {
  state.roundStartedAt = performance.now();
  state.roundElapsedMs = 0;
  state.tickId = window.setInterval(tick, 47);
  tick();
}

function stopRoundTimer() {
  if (!state.tickId) {
    return;
  }
  window.clearInterval(state.tickId);
  state.tickId = 0;
  state.roundElapsedMs = performance.now() - state.roundStartedAt;
}

function tick() {
  state.roundElapsedMs = performance.now() - state.roundStartedAt;
  dom.hudTotal.textContent = formatSeconds(liveTotalMs());

  const limit = currentConfig().limitMs;
  if (limit <= 0) {
    return;
  }

  const remaining = Math.max(0, limit - state.roundElapsedMs);
  dom.screenClock.textContent = `${(remaining / 1000).toFixed(1)}s`;
  dom.meterFill.style.transform = `scaleX(${remaining / limit})`;
  dom.screen.classList.toggle('is-urgent', remaining <= limit * 0.3);

  if (remaining <= 0) {
    endRound(false, '超时');
  }
}

/* ---------------------------------------------------------------- 轮次流程 */

/** 清空一次挑战的全部进度（不动本地记录）。 */
function resetRun() {
  clearTimers();
  morsePlayer.stop();
  state.code = [];
  state.entry = [];
  state.round = 1;
  state.solved = 0;
  state.roundTimes = [];
  state.totalMs = 0;
  state.roundElapsedMs = 0;
  state.reveal = null;
  clearTableHits();
  dom.screen.classList.remove('is-urgent');
  dom.screen.dataset.outcome = '';
}

function idleButtonLabel() {
  return currentConfig().leaderboardKey ? '开始挑战' : '开始练习';
}

function abortToIdle({ status = '待机', foot } = {}) {
  resetRun();
  state.phase = 'idle';
  setStatus(status);
  setFoot(foot ?? currentConfig().description);
  setKeypadEnabled(false);
  setMainButton(idleButtonLabel(), false);
  renderAll();
}

function startRun() {
  resetRun();
  renderAll();
  startRound();
}

/** 开一轮：直接进入破译并开始计时（音效按钮暂时下线，不再有等待播报的阶段）。 */
function startRound() {
  const config = currentConfig();
  state.entry = [];
  state.reveal = null;
  state.roundElapsedMs = 0;
  state.code = randomCode(CODE_LENGTH);
  state.phase = 'running';
  dom.screen.dataset.outcome = '';

  setStatus('破译中');
  setFoot(`第 ${state.round}/${config.rounds} 轮 · 对照线索输入 3 位密码`);
  setKeypadEnabled(true);
  setMainButton('放弃', false);
  renderAll();
  startRoundTimer();
}

function judge() {
  const ok = state.code.every((digit, index) => digit === state.entry[index]);
  endRound(ok, ok ? '' : '密码错误');
}

/** 累计一次练习结果。只记在内存里，不落 storage。 */
function recordPracticeRound(ok, roundMs) {
  state.practice.rounds += 1;
  state.practice.totalMs += roundMs;
  if (!ok) {
    return;
  }
  state.practice.decoded += 1;
  if (state.practice.bestMs === 0 || roundMs < state.practice.bestMs) {
    state.practice.bestMs = roundMs;
  }
}

/** 练习结果文案：本次成绩 + 会话累计。 */
function practiceFoot(ok, roundMs) {
  const { decoded, bestMs } = state.practice;
  const parts = [];
  if (!ok) {
    parts.push(`正确密码 ${state.code.join('')}`);
  }
  parts.push(`本次 ${formatSeconds(roundMs)}`);
  parts.push(`本次会话已破译 ${decoded} 台`);
  if (bestMs > 0) {
    parts.push(`最快单次 ${formatSeconds(bestMs)}`);
  }
  parts.push('点「再来一次」继续');
  return parts.join(' · ');
}

function endRound(ok, reason) {
  if (state.phase !== 'running') {
    return;
  }
  const config = currentConfig();
  const isPractice = !config.leaderboardKey;
  stopRoundTimer();

  const roundMs = state.roundElapsedMs;
  state.roundTimes.push(roundMs);
  state.totalMs += roundMs;
  if (ok) {
    state.solved += 1;
  }

  state.phase = isPractice ? 'practiceResult' : 'roundResult';
  state.reveal = { ok, code: state.code.slice() };
  state.entry = state.code.slice();
  dom.screen.dataset.outcome = ok ? 'ok' : 'bad';
  setKeypadEnabled(false);

  if (ok) {
    setStatus('解锁成功');
    setFoot(`密码 ${state.code.join('')} 正确 · 本轮 ${formatSeconds(roundMs)}`);
    flash('ok');
    notify('解锁成功', 'success');
    vibrate('medium');
  } else {
    setStatus(reason === '超时' ? '破译超时' : '破译失败');
    setFoot(
      `正确密码 ${state.code.join('')} · 本轮 ${formatSeconds(roundMs)}${reason === '超时' ? '（超时）' : ''}`,
    );
    flash('bad');
    notify(reason === '超时' ? '本轮超时' : '密码错误', 'error');
    vibrate('heavy');
  }
  markTableHits();

  // 练习：停在结果页，等用户点「再来一次」。不清空、不自动跳转，方便他回看这一把。
  if (isPractice) {
    recordPracticeRound(ok, roundMs);
    setMainButton('再来一次', false);
    setStatus(ok ? '练习完成' : '练习结束');
    setFoot(practiceFoot(ok, roundMs));
    renderAll();
    return;
  }

  setMainButton('继续中…', true);
  renderAll();

  const holdMs = ok ? WON_HOLD_MS : LOST_HOLD_MS;
  if (state.round >= config.rounds) {
    state.advanceId = window.setTimeout(finishRun, holdMs);
    return;
  }
  state.advanceId = window.setTimeout(() => {
    state.round += 1;
    startRound();
  }, holdMs);
}

/* ------------------------------------------------------------------ 结算 */

function recordRun(config, result) {
  if (!config.leaderboardKey) {
    return;
  }
  state.plays[config.id] = (state.plays[config.id] ?? 0) + 1;
  if (isBetterResult(result, state.best[config.id])) {
    state.best[config.id] = result;
  }
  saveRecord();
}

/**
 * 一行榜单要显示的昵称。
 *
 * 榜单记录里的昵称由各人提交成绩时自己写进 `extra`，而 `extra` 只在**成绩更优**时更新，
 * 所以旧记录里的昵称可能是空的。自己那行优先用实时资料，免得被那条冻结的旧记录卡住。
 * @param {{ profile: { nickname: string }, appUserId?: string }} entry
 * @param {boolean} isMe
 * @param {{ ok: boolean, nickname: string }|undefined} myProfile
 */
function resolveBoardName(entry, isMe, myProfile) {
  if (isMe && myProfile?.nickname) {
    return myProfile.nickname;
  }
  return (
    entry.profile.nickname || (isMe ? '我' : `玩家 ${String(entry.appUserId ?? '').slice(0, 6)}`)
  );
}

/** 把榜单条目渲染进指定列表；`myAppUserId` 命中时高亮为「我」。 */
function renderBoardList(listEl, entries, myAppUserId, myProfile) {
  listEl.replaceChildren(
    ...entries.map((entry) => {
      const isMe = Boolean(myAppUserId && entry.appUserId === myAppUserId);
      const row = document.createElement('li');
      row.className = 'board__row';
      row.classList.toggle('is-me', isMe);

      const rank = document.createElement('span');
      rank.className = 'board__rank';
      rank.textContent = `#${entry.rank}`;

      const who = document.createElement('span');
      who.className = 'board__who';
      const name = document.createElement('span');
      name.className = 'board__name';
      name.textContent = resolveBoardName(entry, isMe, myProfile);
      who.append(name);
      if (isMe) {
        const tag = document.createElement('span');
        tag.className = 'board__tag';
        tag.textContent = '我';
        who.append(tag);
      }

      const score = document.createElement('span');
      score.className = 'board__score';
      score.textContent = `${entry.result.solved} · ${formatSeconds(entry.result.totalMs)}`;

      row.append(rank, who, score);
      return row;
    }),
  );
}

/**
 * 昵称取不到时把原因显式写进状态行：榜上只剩一个「我」，
 * 分不清是资料没读到、还是这条记录里本来就没存过昵称。
 * @param {boolean} hasStoredNickname 这条记录自己在 `extra` 里有没有昵称
 * @param {{ ok: boolean, message?: string }} profile
 */
function boardProfileNote(hasStoredNickname, profile) {
  if (profile.ok || hasStoredNickname) {
    return '';
  }
  return ` · 昵称未取到（${profile.message}）`;
}

/**
 * 刷新常驻排行榜。练习模式没有榜单，直接把面板收起来。
 * @param {{ silent?: boolean }} options silent 为 true 时不显示「正在读取」占位。
 */
async function refreshBoard({ silent = false } = {}) {
  const config = currentConfig();
  // 每次请求都推进 token：切换难度后，在途的旧请求不会覆盖新榜单。
  state.boardToken += 1;
  const token = state.boardToken;

  if (!config.leaderboardKey) {
    dom.boardPanel.hidden = true;
    return;
  }

  dom.boardPanel.hidden = false;
  dom.boardTitle.textContent = `${config.label}排行榜 · 前 ${BOARD_LIMIT}`;
  if (!silent) {
    dom.boardStatus.textContent = '正在读取榜单…';
  }

  const board = await loadBoard(config.leaderboardKey, BOARD_LIMIT);
  if (token !== state.boardToken) {
    return;
  }

  if (!board.ok) {
    dom.boardList.replaceChildren();
    dom.boardStatus.textContent = `榜单暂不可用：${board.message}`;
    return;
  }
  if (board.entries.length === 0) {
    dom.boardList.replaceChildren();
    dom.boardStatus.textContent = '还没有人上榜，完成一次挑战就能占榜首';
    return;
  }

  const [mine, myProfile] = await Promise.all([
    loadMyEntry(config.leaderboardKey),
    loadMyProfile(),
  ]);
  if (token !== state.boardToken) {
    return;
  }

  if (mine.ok && mine.entry) {
    dom.boardStatus.textContent =
      `我的最好成绩：破译 ${mine.entry.result.solved} · 总用时 ${formatSeconds(
        mine.entry.result.totalMs,
      )} · ${formatRank(mine.entry)}` +
      boardProfileNote(Boolean(mine.entry.profile.nickname), myProfile);
  } else {
    dom.boardStatus.textContent = '完成一次挑战即可上榜';
  }

  renderBoardList(
    dom.boardList,
    board.entries,
    mine.ok ? mine.entry?.appUserId : undefined,
    myProfile,
  );
}

async function submitRun(config, result) {
  const submitted = await submitResult(config.leaderboardKey, result);
  dom.resultRank.textContent = submitted.ok
    ? `已提交 · ${formatRank(submitted.entry)}`
    : `成绩未提交：${submitted.message}`;

  // 提交会在当前 runtime 内刷新榜单缓存，紧接着重读能拿到最新名次。
  await refreshBoard({ silent: true });
}

function finishRun() {
  const config = currentConfig();
  const result = makeResult(state.solved, state.totalMs);
  recordRun(config, result);

  state.phase = 'summary';
  state.reveal = null;
  state.entry = [];

  const rounds = config.rounds;
  dom.resultEyebrow.textContent = result.solved === rounds ? '全部破译成功' : `${config.label} · 完成`;
  dom.resultTitle.textContent = config.label;
  dom.resultSolved.textContent = `${result.solved} / ${rounds}`;
  dom.resultTotal.textContent = formatSeconds(result.totalMs);
  dom.resultAverage.textContent = formatSeconds(result.totalMs / rounds);
  dom.resultAccuracy.textContent = `${Math.round((result.solved / rounds) * 100)}%`;
  dom.resultRank.textContent = '正在提交成绩…';

  setStatus('挑战完成');
  setFoot(`${rounds} 轮中破译 ${result.solved} 台`);
  renderAll();

  submitRun(config, result);
}

/* ------------------------------------------------------------------ 交互 */

function press(key) {
  if (state.phase !== 'running') {
    return;
  }
  if (key === 'del') {
    state.entry.pop();
    renderAll();
    return;
  }
  if (key === 'clear') {
    state.entry = [];
    renderAll();
    return;
  }
  if (!/^[0-9]$/.test(key) || state.entry.length >= CODE_LENGTH) {
    return;
  }

  state.entry.push(Number(key));
  renderAll();

  if (state.entry.length === CODE_LENGTH) {
    window.setTimeout(() => {
      if (state.phase === 'running' && state.entry.length === CODE_LENGTH) {
        judge();
      }
    }, VERIFY_DELAY_MS);
  }
}

function onMainAction() {
  if (state.phase === 'running') {
    const config = currentConfig();
    abortToIdle({
      status: '已放弃',
      foot: config.leaderboardKey ? '本次挑战已放弃，未提交成绩' : '已放弃本次练习，可重新开始',
    });
    notify('已放弃');
    return;
  }
  startRun();
}

function selectMode(mode) {
  if (state.mode === mode && state.phase === 'idle') {
    return;
  }
  const wasRunning = state.phase !== 'idle' && state.phase !== 'summary';
  const leavingPractice = state.mode === 'practice' && mode !== 'practice';

  resetRun();
  // 练习的会话累计随离开练习模式一起清空。
  if (leavingPractice) {
    state.practice = { decoded: 0, totalMs: 0, bestMs: 0, rounds: 0 };
  }

  state.mode = mode;
  state.phase = 'idle';
  setStatus('待机');
  setFoot(
    wasRunning
      ? `已切换到${CHALLENGES[mode].label}，本次进度未记录 · ${CHALLENGES[mode].description}`
      : CHALLENGES[mode].description,
  );
  setKeypadEnabled(false);
  setMainButton(idleButtonLabel(), false);
  renderAll();
  // 换难度就换榜单（练习没有榜单，面板会被收起）。
  refreshBoard();
}

function toggleTable() {
  state.wantsTable = !state.wantsTable;
  renderTableVisibility();
}

/*
 * 音效开关暂时下线：开启后需要在播报期间禁用键盘，而玩家可以直接盯着屏幕把密码记下来，
 * 等于绕过了听力考核。后续会做成「仅音效」的独立排行榜模式（隐藏摩斯图案，键盘全程可用），
 * 在那之前不暴露音效按钮。morse.js 里的播放器与 playMorseSequence 保留给那个模式复用，
 * 单行的「试听」按钮不受影响。
 *
 * 页脚的「复制成绩」「重置记录」两个按钮也已去掉：成绩在页脚与常驻榜单里都能看到，
 * 复制没有真实使用场景；重置会清掉本地最好成绩，误触代价大于收益。
 * 因此 package.json 里的 clipboard 权限声明也一并撤掉了（只声明真正用到的能力）。
 */

function bindEvents() {
  dom.btnMain.addEventListener('click', onMainAction);
  dom.btnAgain.addEventListener('click', startRun);
  dom.btnBack.addEventListener('click', () => abortToIdle());
  dom.btnTable.addEventListener('click', toggleTable);
  dom.btnBoardRefresh.addEventListener('click', () => refreshBoard());

  dom.keypad.addEventListener('click', (event) => {
    const key = event.target.closest('.key');
    if (!key || key.disabled) {
      return;
    }
    press(key.dataset.key);
  });

  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (/^[0-9]$/.test(event.key)) {
      press(event.key);
      event.preventDefault();
      return;
    }
    if (event.key === 'Backspace') {
      press('del');
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !dom.actions.hidden && !dom.btnMain.disabled) {
      onMainAction();
      event.preventDefault();
    }
  });
}

function syncNavigationBar() {
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () =>
    hbSDK.viewport
      .setNavigationBarStyle({ foregroundStyle: colorScheme.matches ? 'light' : 'dark' })
      .catch((error) => console.warn('[delta-unlock] 无法同步导航栏样式', error));

  apply();
  if (typeof colorScheme.addEventListener === 'function') {
    colorScheme.addEventListener('change', apply);
  } else if (typeof colorScheme.addListener === 'function') {
    colorScheme.addListener(apply);
  }
}

async function init() {
  buildChips();
  buildSignalRows();
  buildSlots();
  buildTable();
  bindEvents();

  setKeypadEnabled(false);
  setMainButton(idleButtonLabel(), false);
  setFoot(currentConfig().description);
  renderAll();

  syncNavigationBar();

  await loadRecord();
  renderAll();
  refreshBoard();
}

// 安全区要在首屏定版前落到 CSS 变量上，所以和 init() 里的 DOM 构建并行启动，不阻塞它。
void syncViewportInsets(() => hbSDK.viewport.getWindowInfo());

init();

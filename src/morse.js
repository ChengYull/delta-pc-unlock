/**
 * 摩斯数字核心（0-9）。
 *
 * 三角洲行动的「电脑保险」破译终端在左侧给出 3 行摩斯密码，每行对应密码的一位数字，
 * 玩家对照终端上的对照表把 3 行分别译成数字，再在右侧键盘输入 3 位密码。
 *
 * 数字摩斯遵循国际惯例：
 *   1-5 → 前导点的个数就是数字（1 个点在前是 1，5 个点在前是 5）；
 *   6-9 → 前导杠的个数加 5 就是数字（1 个杠在前是 6，4 个杠在前是 9）；
 *   0   → 5 个杠。
 */

/** 有序数字表，用于渲染对照表。 */
export const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** 数字 → 5 位摩斯串（`.` 为点，`-` 为杠）。 */
export const MORSE_BY_DIGIT = {
  0: '-----',
  1: '.----',
  2: '..---',
  3: '...--',
  4: '....-',
  5: '.....',
  6: '-....',
  7: '--...',
  8: '---..',
  9: '----.',
};

/** 摩斯串 → 数字。 */
export const DIGIT_BY_MORSE = Object.freeze(
  Object.fromEntries(Object.entries(MORSE_BY_DIGIT).map(([digit, morse]) => [morse, Number(digit)])),
);

/**
 * 把一段摩斯串译成数字。
 * @param {string} morse 5 位摩斯串。
 * @returns {number|undefined} 命中对照表时返回数字，否则返回 undefined。
 */
export function decodeMorse(morse) {
  return DIGIT_BY_MORSE[morse];
}

/** 密码数字的取值池，0-9。 */
const DIGIT_POOL = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

/**
 * 生成一台上锁电脑的密码，**各位数字互不相同**。
 *
 * 去重的原因：同一位数字重复出现时，两行摩斯会长得一模一样，玩家只要发现「这两行一样」
 * 就少译一位，难度被稀释；而且重复位会让可能的密码从 10³ 缩到更少。
 *
 * 实现用**不放回抽样**（洗牌取前 n 个），不是「随机到不重复为止」的循环重试——
 * 重试在 n 接近 10 时命中率越来越低，期望轮数会失控。
 *
 * @param {number} length 密码位数，默认 3 位；超过 10 时按 10 处理（数字池装不下更多）。
 * @returns {number[]}
 */
export function randomCode(length = 3) {
  const size = Math.min(Math.max(Math.trunc(length) || 0, 0), DIGIT_POOL.length);
  const pool = DIGIT_POOL.slice();
  // 部分 Fisher-Yates：只洗前 size 个位置，剩下的不动。
  for (let i = 0; i < size; i += 1) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size);
}

/** 单点时长（秒）。取 90ms，接近游戏里紧凑的滴答节奏。 */
export const MORSE_UNIT_SECONDS = 0.09;

/** 发声时的目标增益，`level()` 按它归一化成 0-1。 */
const TONE_GAIN = 0.18;

/** `play()` 里音频调度的提前量：给 AudioContext 一点排期余量，避免首符号被吃掉。 */
const SCHEDULE_LEAD_SECONDS = 0.03;

/**
 * 创建一个基于 Web Audio 的摩斯播放器。
 *
 * 两条硬约束：
 * 1. AudioContext 必须在用户手势之后才能出声，调用方负责在点击回调里首次触发。
 * 2. 音效只是观感增强，任何音频异常都不能让调用方挂起——定时器是唯一的完成信号来源。
 *
 * 除播放外还提供 `level()`：当前发声的瞬时电平（0-1），给音频模式的振幅条用。
 * 有音频时读 AnalyserNode 的真实波形；宿主不给音频时退化成「按调度时间线算」，
 * 这样振幅条在没声音的环境（例如浏览器里跑验证）也照样跟着节奏动。
 *
 * @returns {{
 *   play: (morse: string, unitSeconds?: number) => Promise<void>,
 *   stop: () => void,
 *   level: () => number,
 *   isPlaying: () => boolean,
 * }}
 */
export function createMorsePlayer() {
  let context = null;
  let analyser = null;
  let buffer = null;
  let active = null;
  let unavailable = false;

  function ensureContext() {
    if (unavailable) {
      return null;
    }
    if (!context) {
      try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) {
          unavailable = true;
          return null;
        }
        context = new AudioContextCtor();
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        buffer = new Uint8Array(analyser.fftSize);
        analyser.connect(context.destination);
      } catch {
        // 宿主 WebView 未开放音频时静默降级。
        unavailable = true;
        context = null;
        analyser = null;
        return null;
      }
    }
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
    }
    return context;
  }

  function stop() {
    if (!active) {
      return;
    }
    const { oscillator, timerId, resolve } = active;
    active = null;
    window.clearTimeout(timerId);
    if (oscillator) {
      try {
        oscillator.stop();
        oscillator.disconnect();
      } catch {
        // 已经自然结束，忽略。
      }
    }
    resolve();
  }

  /** 当前瞬时电平：优先读真实波形，读不到就按调度时间线给 0/1。 */
  function level() {
    if (!active) {
      return 0;
    }
    if (analyser && buffer && context?.state === 'running') {
      try {
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const value of buffer) {
          const deviation = Math.abs(value - 128);
          if (deviation > peak) {
            peak = deviation;
          }
        }
        return Math.min(1, peak / 128 / TONE_GAIN);
      } catch {
        // 读失败就退回时间线，不影响播放。
      }
    }
    const elapsed = performance.now() - active.startedAtMs;
    for (const [startMs, endMs] of active.segments) {
      if (elapsed >= startMs && elapsed < endMs) {
        return 1;
      }
    }
    return 0;
  }

  function play(morse, unitSeconds = MORSE_UNIT_SECONDS) {
    let audio = null;
    try {
      audio = ensureContext();
    } catch {
      audio = null;
    }
    if (!audio || !morse) {
      return Promise.resolve();
    }

    stop();

    return new Promise((resolve) => {
      let oscillator = null;
      let timerId = 0;

      const done = () => {
        if (active && active.timerId === timerId) {
          active = null;
        }
        if (oscillator) {
          try {
            oscillator.disconnect();
          } catch {
            // 忽略
          }
        }
        resolve();
      };

      try {
        const startAt = audio.currentTime + SCHEDULE_LEAD_SECONDS;
        const gain = audio.createGain();
        oscillator = audio.createOscillator();
        oscillator.type = 'square';
        oscillator.frequency.value = 640;
        oscillator.connect(gain);
        gain.connect(analyser ?? audio.destination);

        // 关断状态起步，避免起始爆音。
        gain.gain.setValueAtTime(0, startAt);

        // 与下面的调度一一对应：供 level() 在拿不到真实波形时还原发声区间。
        const segments = [];
        let cursor = startAt;
        for (const symbol of morse) {
          const toneLength = (symbol === '.' ? 1 : 3) * unitSeconds;
          const releaseAt = cursor + toneLength;
          gain.gain.linearRampToValueAtTime(TONE_GAIN, cursor + 0.004);
          gain.gain.setValueAtTime(TONE_GAIN, Math.max(cursor + 0.004, releaseAt - 0.004));
          gain.gain.linearRampToValueAtTime(0, releaseAt);
          segments.push([
            (cursor - startAt) * 1000 + SCHEDULE_LEAD_SECONDS * 1000,
            ((releaseAt - startAt) * 1000) + SCHEDULE_LEAD_SECONDS * 1000,
          ]);
          // 符号之间留 1 个单位静默。
          cursor = releaseAt + unitSeconds;
        }

        oscillator.start(startAt);
        oscillator.stop(cursor + 0.02);

        const totalMs = (cursor - startAt + 0.05) * 1000;
        timerId = window.setTimeout(done, totalMs);
        active = { oscillator, timerId, resolve, segments, startedAtMs: performance.now() };
      } catch {
        // 音频调度失败（例如 AudioContext 被系统回收）时直接放行，不阻塞回合。
        done();
      }
    });
  }

  return { play, stop, level, isPlaying: () => Boolean(active) };
}

/** 播放多行摩斯时，行与行之间默认留的停顿（毫秒）。 */
export const MORSE_LINE_GAP_MS = 260;

const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * 依次播放多行摩斯，行与行之间留出停顿。
 *
 * @param {{ play: (morse: string, unitSeconds?: number) => Promise<void> }} player
 * @param {string[]} lines
 * @param {{
 *   gapMs?: number,
 *   onLine?: (index: number) => void,
 *   isCancelled?: () => boolean,
 * }} [options]
 *   `onLine(index)`：某一行开始播时报出它的序号，全部播完报 `-1`。
 *   `isCancelled()`：返回 true 时立刻收工（玩家抢答成功、放弃、切难度都要掐掉播放），
 *   此时返回 false；正常播完返回 true。
 * @returns {Promise<boolean>}
 */
export async function playMorseSequence(player, lines, options = {}) {
  const { gapMs = MORSE_LINE_GAP_MS, onLine = null, isCancelled = null } = options;
  for (let index = 0; index < lines.length; index += 1) {
    if (isCancelled?.()) {
      return false;
    }
    onLine?.(index);
    await player.play(lines[index]);
    if (isCancelled?.()) {
      return false;
    }
    if (gapMs > 0) {
      await delay(gapMs);
    }
  }
  onLine?.(-1);
  return true;
}

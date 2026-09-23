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

/**
 * 生成一台上锁电脑的密码。
 * @param {number} length 密码位数，默认 3 位。
 * @returns {number[]}
 */
export function randomCode(length = 3) {
  return Array.from({ length }, () => Math.floor(Math.random() * 10));
}

/** 单点时长（秒）。取 90ms，接近游戏里紧凑的滴答节奏。 */
export const MORSE_UNIT_SECONDS = 0.09;

/**
 * 创建一个基于 Web Audio 的摩斯播放器。
 *
 * 两条硬约束：
 * 1. AudioContext 必须在用户手势之后才能出声，调用方负责在点击回调里首次触发。
 * 2. 音效只是观感增强，任何音频异常都不能让调用方挂起——定时器是唯一的完成信号来源。
 *
 * @returns {{ play: (morse: string, unitSeconds?: number) => Promise<void>, stop: () => void }}
 */
export function createMorsePlayer() {
  let context = null;
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
      } catch {
        // 宿主 WebView 未开放音频时静默降级。
        unavailable = true;
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
        const startAt = audio.currentTime + 0.03;
        const gain = audio.createGain();
        oscillator = audio.createOscillator();
        oscillator.type = 'square';
        oscillator.frequency.value = 640;
        oscillator.connect(gain);
        gain.connect(audio.destination);

        // 关断状态起步，避免起始爆音。
        gain.gain.setValueAtTime(0, startAt);

        let cursor = startAt;
        for (const symbol of morse) {
          const toneLength = (symbol === '.' ? 1 : 3) * unitSeconds;
          const releaseAt = cursor + toneLength;
          gain.gain.linearRampToValueAtTime(0.18, cursor + 0.004);
          gain.gain.setValueAtTime(0.18, Math.max(cursor + 0.004, releaseAt - 0.004));
          gain.gain.linearRampToValueAtTime(0, releaseAt);
          // 符号之间留 1 个单位静默。
          cursor = releaseAt + unitSeconds;
        }

        oscillator.start(startAt);
        oscillator.stop(cursor + 0.02);

        const totalMs = (cursor - startAt + 0.05) * 1000;
        timerId = window.setTimeout(done, totalMs);
        active = { oscillator, timerId, resolve };
      } catch {
        // 音频调度失败（例如 AudioContext 被系统回收）时直接放行，不阻塞回合。
        done();
      }
    });
  }

  return { play, stop };
}

/**
 * 依次播放多行摩斯，行与行之间留出停顿。
 * @param {{ play: (morse: string, unitSeconds?: number) => Promise<void>, stop: () => void }} player
 * @param {string[]} lines
 * @param {number} gapMs 行间隔毫秒。
 */
export async function playMorseSequence(player, lines, gapMs = 260) {
  for (const line of lines) {
    await player.play(line);
    await new Promise((resolve) => window.setTimeout(resolve, gapMs));
  }
}

/**
 * 挑战配置与计分。
 *
 * 四种模式分两类：
 *   - 练习：单次破译，不计成绩，不写榜单。
 *   - 挑战：连续 N 轮破译，结算后按「破译数优先、总时间次之」写入对应榜单。
 */

/** 每轮密码位数：三角洲行动的电脑保险固定 3 位。 */
export const CODE_LENGTH = 3;

/**
 * @typedef {object} ChallengeConfig
 * @property {string} id            模式 id
 * @property {string} label         模式名
 * @property {string} chip          难度按钮上的短标签
 * @property {number} rounds        一次挑战包含的破译轮数
 * @property {number} limitMs       单轮限时毫秒，0 表示不限时
 * @property {string|null} leaderboardKey 对应榜单 key，null 表示不计榜
 * @property {string} description   待机时展示的一句话说明
 */

/** @type {Record<string, ChallengeConfig>} */
export const CHALLENGES = {
  practice: {
    id: 'practice',
    label: '练习',
    chip: '练习',
    rounds: 1,
    limitMs: 0,
    leaderboardKey: null,
    description: '单次破译 · 不计成绩 · 仅本次会话累计，离开练习即清空',
  },
  novice: {
    id: 'novice',
    label: '新手挑战',
    chip: '新手',
    rounds: 5,
    limitMs: 0,
    leaderboardKey: 'novice_challenge',
    description: '5 次破译 · 不限时 · 参与新手排行榜',
  },
  skilled: {
    id: 'skilled',
    label: '熟练挑战',
    chip: '熟练',
    rounds: 10,
    limitMs: 8000,
    leaderboardKey: 'skilled_challenge',
    description: '10 次破译 · 每次限时 8 秒 · 参与熟练排行榜',
  },
  expert: {
    id: 'expert',
    label: '专家挑战',
    chip: '专家',
    rounds: 15,
    limitMs: 5000,
    leaderboardKey: 'expert_challenge',
    description: '15 次破译 · 每次限时 5 秒 · 参与专家排行榜',
  },
};

/** 难度按钮的展示顺序。 */
export const CHALLENGE_ORDER = ['practice', 'novice', 'skilled', 'expert'];

/**
 * 榜单只有一个数值 `score` 参与排序，`extra` 不参与排序，所以把两项编码进一个数：
 *
 *   score = 破译数 × 1e6 + (1e6 − 总毫秒)     order = desc
 *
 * 破译数多者恒胜出；破译数相同时总时间短者胜。最大值约 1.6e7，远低于安全整数上限。
 * 总毫秒上限取 999_999（约 16.6 分钟），超过则夹取——专家挑战封顶只有 75 秒，
 * 正常不可能触及，这里只为保证编码可逆。
 */
export const SCORE_SCALE = 1_000_000;
const MAX_TOTAL_MS = SCORE_SCALE - 1;

/**
 * @param {{ solved: number, totalMs: number }} result
 * @returns {number} 可提交给排行榜的分数。
 */
export function encodeScore({ solved, totalMs }) {
  const safeSolved = Math.max(0, Math.round(solved));
  const safeMs = Math.min(Math.max(0, Math.round(totalMs)), MAX_TOTAL_MS);
  return safeSolved * SCORE_SCALE + (SCORE_SCALE - safeMs);
}

/**
 * 把榜单分数还原成「破译数 + 总时间」，用于展示别人的成绩。
 * @param {number} score
 * @returns {{ solved: number, totalMs: number }}
 */
export function decodeScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) {
    return { solved: 0, totalMs: 0 };
  }
  const solved = Math.floor(score / SCORE_SCALE);
  return { solved, totalMs: SCORE_SCALE - (score - solved * SCORE_SCALE) };
}

/**
 * 从榜单记录的 `extra` 里读成绩，读不到时回退到解码 `score`。
 * `extra` 是公开展示用的小 JSON，不参与排序。
 * @param {{ score: number, extra?: unknown }} entry
 */
export function readEntryResult(entry) {
  const extra = entry?.extra;
  if (extra && typeof extra === 'object') {
    const solved = extra.solved ?? extra.c;
    const totalMs = extra.totalMs ?? extra.t;
    if (typeof solved === 'number' && typeof totalMs === 'number' && solved >= 0 && totalMs >= 0) {
      return { solved, totalMs };
    }
  }
  return decodeScore(entry?.score ?? 0);
}

/**
 * 昵称与头像也走 `extra` 公开返回。服务端对 `extra` 有 2048 UTF-8 字节的上限，
 * 超了整次提交会被 `INVALID_PARAMS` 拒掉（成绩一起丢掉），所以上传前必须先自己夹长度。
 */
export const MAX_NICKNAME_LENGTH = 20;
export const MAX_AVATAR_LENGTH = 512;

/**
 * 规范化昵称：控制字符和换行会破坏榜单单行排版，统一折叠成空格再裁长度。
 * @param {unknown} value
 */
export function normalizeNickname(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NICKNAME_LENGTH);
}

/**
 * 规范化头像地址。只接受绝对 https 地址：相对路径在榜单里没有可解析的基准，
 * 平台 CSP 也只放行自己的资源域名，其余地址交给 `<img>` 的 onerror 兜底即可。
 * @param {unknown} value
 */
export function normalizeAvatar(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const url = value.trim();
  return /^https:\/\//i.test(url) ? url.slice(0, MAX_AVATAR_LENGTH) : '';
}

/**
 * 从榜单记录的 `extra` 里读昵称与头像。早期记录（或资料读取失败时提交的记录）
 * 里没有这两项，返回空串交由展示层回退。
 * @param {{ extra?: unknown }} entry
 * @returns {{ nickname: string, avatar: string }}
 */
export function readEntryProfile(entry) {
  const extra = entry?.extra;
  if (!extra || typeof extra !== 'object') {
    return { nickname: '', avatar: '' };
  }
  return {
    nickname: normalizeNickname(extra.nickname),
    avatar: normalizeAvatar(extra.avatar),
  };
}

/**
 * 比较两条成绩，返回 a 是否优于 b（破译数优先，总时间次之）。
 * @param {{ solved: number, totalMs: number }} a
 * @param {{ solved: number, totalMs: number }} b
 */
export function isBetterResult(a, b) {
  if (!b) {
    return true;
  }
  if (a.solved !== b.solved) {
    return a.solved > b.solved;
  }
  return a.totalMs < b.totalMs;
}

/**
 * 生成本地记录用的成绩对象。
 * @param {number} solved
 * @param {number} totalMs
 */
export function makeResult(solved, totalMs) {
  return { solved, totalMs: Math.max(0, Math.round(totalMs)) };
}

/** 把毫秒格式化成秒，成绩展示统一走这里。 */
export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** 成绩的短展示形态，例如 `5/12.40s`。 */
export function formatResult(result) {
  if (!result) {
    return '—';
  }
  return `${result.solved}/${formatSeconds(result.totalMs)}`;
}

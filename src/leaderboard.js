/**
 * 云端排行榜封装（`hbSDK.cloud.leaderboard`）。
 *
 * 榜单由 CLI 预先创建：
 *   hb-sdk remote cloud leaderboard create <key> --order desc --rank-limit 500
 *
 * 页面侧统一把失败收敛成 `{ ok: false, message }`，避免排行榜不可用时把挑战流程打挂。
 * 榜单是加分项，不是游戏必需能力。
 */
import hbSDK, { HbMiniProgramSDKError } from '@heybox/hb-sdk';
import { encodeScore, readEntryResult } from './challenge.js';

/** 榜单里给当前用户高亮用的标记，展示层对比 appUserId 使用。 */
const ERROR_TEXT = {
  UNAUTHORIZED: '需要在小黑盒内登录后才能提交成绩',
  NOT_IN_IFRAME: '排行榜需要在小黑盒客户端内运行',
  LEADERBOARD_DEFAULT_NOT_FOUND: '榜单尚未创建',
  LEADERBOARD_NOT_FOUND: '榜单尚未创建',
  PERMISSION_NOT_DECLARED: '项目未声明 leaderboard 权限',
  PERMISSION_DENIED: 'leaderboard 权限未获批准',
  METHOD_FORBIDDEN: '当前客户端未开放排行榜能力',
  METHOD_NOT_FOUND: '当前客户端版本过旧，暂不支持排行榜',
  REQUEST_UNSUPPORTED: '当前客户端不支持该请求',
  INVALID_PARAMS: '成绩数据非法',
};

/**
 * 把 SDK 错误翻译成可以直接展示的一句话。
 * @param {unknown} error
 */
export function describeLeaderboardError(error) {
  if (error instanceof HbMiniProgramSDKError) {
    return ERROR_TEXT[error.code] ?? `排行榜调用失败（${error.code}）`;
  }
  return '排行榜调用失败';
}

/**
 * 提交本次挑战成绩。同一个用户在同一个榜单里只有一条记录，
 * 服务端只在成绩更优时覆盖，所以返回的 `entry` 才是最终落库结果。
 * @param {string} key
 * @param {{ solved: number, totalMs: number }} result
 */
export async function submitResult(key, result) {
  try {
    const entry = await hbSDK.cloud.leaderboard.submit({
      key,
      score: encodeScore(result),
      extra: { solved: result.solved, totalMs: result.totalMs },
    });
    return { ok: true, entry, result };
  } catch (error) {
    return { ok: false, message: describeLeaderboardError(error), code: error?.code };
  }
}

/**
 * 读取公开榜单列表。不需要登录。
 * @param {string} key
 * @param {number} limit 1-100
 */
export async function loadBoard(key, limit = 10) {
  try {
    const page = await hbSDK.cloud.leaderboard.getList({ key, limit });
    const entries = (page.entries ?? []).map((entry) => ({
      rank: entry.rank,
      appUserId: entry.appUserId,
      score: entry.score,
      result: readEntryResult(entry),
    }));
    return { ok: true, entries, hasMore: Boolean(page.hasMore), cursor: page.cursor };
  } catch (error) {
    return { ok: false, message: describeLeaderboardError(error), code: error?.code };
  }
}

/**
 * 读取当前用户在该榜单的成绩。未登录返回 `UNAUTHORIZED`，无记录返回 `undefined`，
 * 两者都不是异常。
 * @param {string} key
 */
export async function loadMyEntry(key) {
  try {
    const entry = await hbSDK.cloud.leaderboard.getCurrentUserEntry({ key });
    if (!entry) {
      return { ok: true, entry: undefined };
    }
    return { ok: true, entry: { ...entry, result: readEntryResult(entry) } };
  } catch (error) {
    if (error instanceof HbMiniProgramSDKError && error.code === 'UNAUTHORIZED') {
      return { ok: false, message: ERROR_TEXT.UNAUTHORIZED, code: error.code };
    }
    return { ok: false, message: describeLeaderboardError(error), code: error?.code };
  }
}

/**
 * 展示名次的统一文案。`ranked: false` 时不能把 `rank: 0` 当成真实名次。
 * @param {{ ranked?: boolean, rank?: number }|undefined} entry
 */
export function formatRank(entry) {
  if (!entry) {
    return '成绩已保存';
  }
  return entry.ranked === false ? '成绩已保存' : `第 ${entry.rank} 名`;
}

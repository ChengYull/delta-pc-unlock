/**
 * 云端排行榜封装（`hbSDK.cloud.leaderboard`）。
 *
 * 榜单由 CLI 预先创建：
 *   hb-sdk remote cloud leaderboard create <key> --order desc --rank-limit 500
 *
 * 页面侧统一把失败收敛成 `{ ok: false, message }`，避免排行榜不可用时把挑战流程打挂。
 * 榜单是加分项，不是游戏必需能力。
 *
 * 关于昵称与头像：`getList()` 只返回 `appUserId`（不透明的隔离标识）+ `score` + `extra`，
 * 平台没有提供「用 appUserId 反查别人资料」的接口。所以榜单上每个人的昵称与头像只能由
 * 各人**自己**在提交成绩时写进 `extra`（见 `loadMyProfile`），页面再原样读出来展示。
 */
import hbSDK, { HbMiniProgramSDKError } from '@heybox/hb-sdk';
import {
  encodeScore,
  normalizeAvatar,
  normalizeNickname,
  readEntryProfile,
  readEntryResult,
} from './challenge.js';

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

/** 用户资料是附加展示信息，读不到也不能影响成绩提交，所以单独一套提示文案。 */
const PROFILE_ERROR_TEXT = {
  PERMISSION_NOT_DECLARED: '项目未声明 userInfo 权限',
  PERMISSION_DENIED: 'userInfo 权限未获批准',
  METHOD_FORBIDDEN: '当前客户端未开放用户资料',
  METHOD_NOT_FOUND: '当前客户端版本过旧，读不到用户资料',
  INVALID_STATE: '用户身份未就绪',
  REQUEST_FAILED: '用户资料读取失败',
  REQUEST_UNSUPPORTED: '当前客户端不支持读取用户资料',
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

/** 同上，用于用户资料失败。 */
function describeProfileError(error) {
  if (error instanceof HbMiniProgramSDKError) {
    return PROFILE_ERROR_TEXT[error.code] ?? '用户资料读取失败';
  }
  return '用户资料读取失败';
}

/** 会话级资料缓存：成功就复用，失败不缓存（下次提交还能再试）。 */
let profilePromise = null;

/**
 * 读取当前用户的昵称与头像。`user.getInfo()` 不弹授权框、不要求可信手势，
 * 未登录时返回 `isHeyboxAppLoggedIn: false`（正常分支，不抛错）。
 *
 * 首次调用会命中宿主，之后走会话内缓存——同一个会话里昵称头像不会变，
 * 重复提交成绩时不必再问一次宿主。
 *
 * @returns {Promise<{ ok: boolean, appUserId?: string, nickname: string, avatar: string, message?: string }>}
 */
export function loadMyProfile() {
  profilePromise ??= readMyProfile().then((profile) => {
    if (!profile.ok) {
      profilePromise = null;
    }
    return profile;
  });
  return profilePromise;
}

async function readMyProfile() {
  try {
    const result = await hbSDK.user.getInfo();
    if (!result?.isHeyboxAppLoggedIn) {
      return { ok: false, nickname: '', avatar: '', message: '未登录小黑盒账号' };
    }
    if (!result.userInfo) {
      return { ok: false, nickname: '', avatar: '', message: '用户资料未披露' };
    }
    return {
      ok: true,
      appUserId: result.userInfo.app_user_id,
      nickname: normalizeNickname(result.userInfo.profile?.nickname),
      avatar: normalizeAvatar(result.userInfo.profile?.avatar),
    };
  } catch (error) {
    return { ok: false, nickname: '', avatar: '', message: describeProfileError(error) };
  }
}

/**
 * 提交本次挑战成绩。同一个用户在同一个榜单里只有一条记录，
 * 服务端只在成绩更优时覆盖，所以返回的 `entry` 才是最终落库结果。
 *
 * 昵称与头像搭 `extra` 一起提交——榜单列表只能从这里读到它们。资料读取失败时
 * 只提交成绩，不让附加信息拖垮主流程。
 * @param {string} key
 * @param {{ solved: number, totalMs: number }} result
 */
export async function submitResult(key, result) {
  const profile = await loadMyProfile();

  try {
    const entry = await hbSDK.cloud.leaderboard.submit({
      key,
      score: encodeScore(result),
      extra: {
        solved: result.solved,
        totalMs: result.totalMs,
        nickname: profile.nickname,
        avatar: profile.avatar,
      },
    });
    return { ok: true, entry, result, profile };
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
      profile: readEntryProfile(entry),
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
    return {
      ok: true,
      entry: { ...entry, result: readEntryResult(entry), profile: readEntryProfile(entry) },
    };
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

/**
 * 容器几何适配：把宿主的真实安全区换算成 CSS 变量。
 *
 * 小程序 WebView 是沉浸式的——内容从窗口第一行像素开始，宿主则在状态栏之下、
 * 右上角浮一组「更多 / 分享」按钮，底部压一条手势条。纯 CSS 的
 * `env(safe-area-inset-*)` 在宿主 WebView 里未必有值（桌面调试台实测为 0），
 * 所以顶部避让必须问宿主拿几何信息：`viewport.getWindowInfo()` 不需要声明权限、
 * 不弹授权、也不依赖登录。
 *
 * 本模块只做「几何 → CSS 变量」，不直接引用 SDK：读取方式由调用方传进来，
 * 这样换算逻辑是纯函数，能脱离浏览器直接测。
 *
 * 两个坑都在这里收口：
 *   1. `statusBarHeight` 报的**不是状态栏高度**，而是宿主那条顶部栏的下沿：
 *      调试宿主把它算成「设备状态栏高度 + 44」，`safeArea.top` 也一样加过（见
 *      HOST_TOP_BAND）。顶栏要和悬浮按钮同处一行，就得把这 44 减掉，否则整条
 *      顶栏会被压到悬浮区下面，顶部空出一大段。
 *   2. `safeArea` 四边是**边界坐标**不是内边距：左/上直接就是内边距，
 *      右/下要用窗口尺寸减。
 *
 * 样式侧只消费变量，不自己算：
 *   --safe-top / --safe-right / --safe-bottom / --safe-left
 *
 * 读不到时什么都不写，CSS 会退回 `env()` 兜底。
 */

/** 安全区算出来超过窗口这个比例就认为坐标不可信，一律当成没有安全区。 */
const MAX_INSET_RATIO = 0.25;

/** 没有窗口尺寸可参照时，内边距的绝对上限（安全区再大也大不过这个数）。 */
const FALLBACK_INSET_LIMIT = 200;

/** PC 窗口可以被用户拖拽，宿主不推尺寸变化，只能自己防抖重读。 */
const RESIZE_DEBOUNCE_MS = 200;

/**
 * 宿主自己那条顶部栏的高度：状态栏之下、右上角「更多 / 分享」所在的一条。
 * 上边距 6 + 按钮 32 + 下边距 6 = 44。
 *
 * 出处是调试宿主的实现——`node_modules/@heybox/hb-sdk/dist/devtools/browser-dev-host/assets/
 * browser-dev-host-*.js` 里的 `const Xs = 44`，它同时被加在 `statusBarHeight` 与
 * `safeArea.top` 上。真机实测也吻合：宿主报 84 的机器，悬浮按钮落在窗口顶部 46–78，
 * 反推状态栏 40（84 = 40 + 44）。
 */
const HOST_TOP_BAND = 44;

/**
 * 状态栏在 CSS 像素下不会高过这个数（刘海机 iOS 最高 62，安卓更矮）。
 * 报回来比它还高，就说明里面含了宿主那条顶部栏，要减掉 44；
 * 留出余量是为了别把「只报了状态栏」的宿主反而减亏——那种宿主本来就该原样用。
 */
const MAX_PLAUSIBLE_STATUS_BAR = 64;

/** 只认有限正数，其余（含 `undefined` / `NaN` / 字符串）统一归零。 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 窗口尺寸缺失时退回屏幕尺寸。 */
function sizeOf(primary, fallback) {
  return positive(primary) || positive(fallback);
}

/** 超过窗口四分之一、或者不是正数，一律归零。宁可少留白，也不能把整窗写进内边距。 */
function clampInset(inset, windowSize) {
  const limit = windowSize ? windowSize * MAX_INSET_RATIO : FALLBACK_INSET_LIMIT;
  return inset > 0 && inset <= limit ? inset : 0;
}

/** 左/上边界坐标**本身就是**内边距（从窗口左/上边缘起算），不做减法。 */
function leadingEdgeInset(coordinate, windowSize) {
  return clampInset(positive(coordinate), windowSize);
}

/**
 * 右/下边界坐标要翻成内边距：窗口尺寸减去边界。
 * 窗口尺寸缺失时退回边界值本身，反正后面还有一层夹取兜底。
 */
function trailingEdgeInset(coordinate, windowSize) {
  const edge = positive(coordinate);
  if (edge === 0) {
    return 0;
  }
  return clampInset(windowSize ? windowSize - edge : edge, windowSize);
}

/**
 * 顶部要避让到哪：**状态栏下沿**，也就是宿主那条悬浮栏的上沿。
 * 宿主报的是「状态栏 + 它那条栏」的下沿，减掉 HOST_TOP_BAND 才是状态栏下沿；
 * 只有明显高过状态栏可能的高度时才减，免得把只报状态栏的宿主减亏。
 */
function statusBarBottom(reportedTop) {
  return reportedTop > MAX_PLAUSIBLE_STATUS_BAR ? Math.max(reportedTop - HOST_TOP_BAND, 0) : reportedTop;
}

/**
 * 把 `viewport.getWindowInfo()` 的快照换算成四边内边距。
 *
 * 顶部取「状态栏」与「安全区上边界」的较大者：前者是状态栏/顶部导航的占用，
 * 后者在有刘海或灵动岛时更靠下，两个都得让开。
 *
 * @param {object} [info]
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function computeInsets(info) {
  const windowWidth = sizeOf(info?.windowWidth, info?.screenWidth);
  const windowHeight = sizeOf(info?.windowHeight, info?.screenHeight);
  const safeArea = info?.safeArea ?? {};
  const reportedTop = Math.max(positive(info?.statusBarHeight), positive(safeArea.top));

  return {
    top: clampInset(statusBarBottom(reportedTop), windowHeight),
    right: trailingEdgeInset(safeArea.right, windowWidth),
    bottom: trailingEdgeInset(safeArea.bottom, windowHeight),
    left: leadingEdgeInset(safeArea.left, windowWidth),
  };
}

/**
 * 把内边距写进 CSS 变量。传 `root` 是为了让单测能在 Node 里塞一个假的样式表。
 *
 * 顶部为 0 时不是写 `0px` 而是写回 `env()`：宿主这一项读失败（文档里会降级成 0）
 * 时，不能把刘海也一起丢掉。其余三边写 `0px` 即可，样式那边取的是两者较大者。
 *
 * @param {{ top: number, right: number, bottom: number, left: number }} insets
 * @param {HTMLElement} [root]
 */
export function applyInsets(insets, root = document.documentElement) {
  if (!root) {
    return;
  }
  for (const [edge, value] of Object.entries(insets)) {
    if (value > 0) {
      root.style.setProperty(`--safe-${edge}`, `${value}px`);
      continue;
    }
    root.style.setProperty(`--safe-${edge}`, edge === 'top' ? 'env(safe-area-inset-top, 0px)' : '0px');
  }
}

let resizeBound = false;

/** 窗口尺寸变了就重读一次；宿主不会推变化，只能自己监听。 */
function bindResize(readWindowInfo, root) {
  if (resizeBound || typeof window === 'undefined') {
    return;
  }
  resizeBound = true;

  let timer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        applyInsets(computeInsets(await readWindowInfo()), root);
      } catch {
        // 重读失败就保持上一次的几何信息，不动变量。
      }
    }, RESIZE_DEBOUNCE_MS);
  });
}

/**
 * 读取窗口几何并落到 CSS 变量上。
 *
 * @param {() => Promise<object>} readWindowInfo 通常直接传 `hbSDK.viewport.getWindowInfo`。
 * @param {HTMLElement} [root]
 * @returns {Promise<{ top: number, right: number, bottom: number, left: number } | null>}
 *   `null` 表示宿主没给几何信息，此时样式退回 `env()` 兜底。
 */
export async function syncViewportInsets(readWindowInfo, root = document.documentElement) {
  try {
    const insets = computeInsets(await readWindowInfo());
    applyInsets(insets, root);
    bindResize(readWindowInfo, root);
    return insets;
  } catch (error) {
    console.warn('[delta-unlock] 读取窗口几何信息失败，安全区退回 CSS env()', error);
    return null;
  }
}

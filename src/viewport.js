/**
 * 容器几何适配：把宿主的真实安全区换算成 CSS 变量。
 *
 * 小程序 WebView 是沉浸式的——内容从窗口第一行像素开始，而宿主会在状态栏之下、
 * 右上角浮一组「更多 / 分享」按钮，底部还会压一条手势条。纯 CSS 的
 * `env(safe-area-inset-*)` 在宿主 WebView 里未必有值（桌面调试台实测为 0），
 * 所以顶部避让必须问宿主拿几何信息：`viewport.getWindowInfo()` 不需要声明权限、
 * 不弹授权、也不依赖登录。
 *
 * 本模块只做「几何 → CSS 变量」，不直接引用 SDK：读取方式由调用方传进来，
 * 这样换算逻辑是纯函数，能脱离浏览器直接测。
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

/** 只认有限正数，其余（含 `undefined` / `NaN` / 字符串）统一归零。 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 窗口尺寸缺失时退回屏幕尺寸。 */
function sizeOf(primary, fallback) {
  return positive(primary) || positive(fallback);
}

/**
 * 安全区边界坐标 → 内边距。
 *
 * `safeArea` 的四个字段都是**边界坐标**（从窗口左/上边缘起算），不是内边距，
 * 右侧和底部要做减法。宿主补不出有效坐标时算出来会贴着整个窗口，那种情况归零：
 * 宁可少留白，也不能把一个窗口宽的内边距写进去。
 *
 * @param {unknown} edgeCoordinate
 * @param {number} windowSize
 */
function coordinateToInset(edgeCoordinate, windowSize) {
  const edge = positive(edgeCoordinate);
  if (edge === 0) {
    return 0;
  }
  const limit = windowSize ? windowSize * MAX_INSET_RATIO : FALLBACK_INSET_LIMIT;
  const inset = windowSize ? windowSize - edge : edge;
  return inset > 0 && inset <= limit ? inset : 0;
}

/**
 * 把 `viewport.getWindowInfo()` 的快照换算成四边内边距。
 *
 * 顶部取「状态栏高度」与「安全区上边界」的较大者：前者是状态栏/顶部导航的占用，
 * 后者在有刘海或灵动岛时更靠下，两个都得让开。
 *
 * @param {object} [info]
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function computeInsets(info) {
  const windowWidth = sizeOf(info?.windowWidth, info?.screenWidth);
  const windowHeight = sizeOf(info?.windowHeight, info?.screenHeight);
  const safeArea = info?.safeArea ?? {};

  return {
    top: Math.max(positive(info?.statusBarHeight), coordinateToInset(safeArea.top, windowHeight)),
    right: coordinateToInset(safeArea.right, windowWidth),
    bottom: coordinateToInset(safeArea.bottom, windowHeight),
    left: coordinateToInset(safeArea.left, windowWidth),
  };
}

/**
 * 把内边距写进 CSS 变量。传 `root` 是为了让单测能在 Node 里塞一个假的样式表。
 * @param {{ top: number, right: number, bottom: number, left: number }} insets
 * @param {HTMLElement} [root]
 */
export function applyInsets(insets, root = document.documentElement) {
  if (!root) {
    return;
  }
  for (const [edge, value] of Object.entries(insets)) {
    root.style.setProperty(`--safe-${edge}`, `${value}px`);
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

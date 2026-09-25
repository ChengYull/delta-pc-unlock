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
 * 两个坑都在这里收口：
 *   1. 单位。文档说字段是逻辑像素，但部分 Android 机型上 Host 回传的是物理像素，
 *      照 CSS 像素用会在顶栏上方多顶出一条状态栏的高度。靠 `window.innerWidth` 校正。
 *   2. 语义。`safeArea` 四边是**边界坐标**不是内边距：左/上直接就是内边距，
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

/** 宿主报告的窗口宽度比 WebView 视口宽度大出这个倍数，就认定整组数值是物理像素。 */
const PHYSICAL_PIXEL_THRESHOLD = 1.5;

/** 只认有限正数，其余（含 `undefined` / `NaN` / 字符串）统一归零。 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 窗口尺寸缺失时退回屏幕尺寸。 */
function sizeOf(primary, fallback) {
  return positive(primary) || positive(fallback);
}

/**
 * 判断宿主这组几何数值的单位，返回需要除掉的倍数。
 *
 * 文档说 `getWindowInfo()` 的字段都是逻辑像素，但部分 Android 机型上 Host 直接
 * 透传原生像素：1080×2400 / DPR 3 的机器会把 28dp 的状态栏报成 `statusBarHeight = 84`。
 * 照 CSS 像素用就会在顶栏上方多顶出一整条状态栏的高度（实测就是这样）。
 *
 * WebView 自己的 `window.innerWidth` 是确定的 CSS 像素，拿宿主报告的窗口宽度一比
 * 就知道：比值达到 `pixelRatio` 量级 → 这组数字全是物理像素，统一除回去；
 * 比值 1 附近（PC 上最多差一个滚动条）→ 本来就是逻辑像素，不动。
 *
 * 之所以不直接用 `info.pixelRatio` 判断：低版本宿主未必回传这个字段（降级成 1），
 * 而 `innerWidth` 任何版本都有。
 *
 * @param {unknown} info
 * @param {unknown} viewportWidth WebView 视口宽度（CSS 像素），通常传 `window.innerWidth`
 */
export function resolveUnitScale(info, viewportWidth) {
  const reported = sizeOf(info?.windowWidth, info?.screenWidth);
  const reference = positive(viewportWidth);
  if (!reported || !reference) {
    return 1;
  }
  const ratio = reported / reference;
  return ratio >= PHYSICAL_PIXEL_THRESHOLD ? ratio : 1;
}

/**
 * 把内边距夹到可信范围：超过窗口四分之一、或者不是正数，一律归零。
 * 宿主补不出有效坐标时算出来会贴着整个窗口，那种情况宁可少留白。
 */
function clampInset(inset, windowSize) {
  const limit = windowSize ? windowSize * MAX_INSET_RATIO : FALLBACK_INSET_LIMIT;
  return inset > 0 && inset <= limit ? inset : 0;
}

/** 左/上边界坐标**本身就是**内边距（从窗口左/上边缘起算），不做减法。 */
function leadingEdgeInset(coordinate, scale, windowSize) {
  return clampInset(positive(coordinate) / scale, windowSize);
}

/**
 * 右/下边界坐标要翻成内边距：窗口尺寸减去边界。
 * 窗口尺寸缺失时退回边界值本身，反正后面还有一层夹取兜底。
 */
function trailingEdgeInset(coordinate, scale, windowSize) {
  const edge = positive(coordinate);
  if (edge === 0) {
    return 0;
  }
  const inset = windowSize ? windowSize - edge / scale : edge / scale;
  return clampInset(inset, windowSize);
}

/**
 * 把 `viewport.getWindowInfo()` 的快照换算成四边内边距。
 *
 * 顶部取「状态栏高度」与「安全区上边界」的较大者：前者是状态栏/顶部导航的占用，
 * 后者在有刘海或灵动岛时更靠下，两个都得让开。
 *
 * @param {object} [info]
 * @param {unknown} [viewportWidth] WebView 视口宽度，用于识别物理像素，见 `resolveUnitScale`
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function computeInsets(info, viewportWidth) {
  const scale = resolveUnitScale(info, viewportWidth);
  const windowWidth = sizeOf(info?.windowWidth, info?.screenWidth) / scale;
  const windowHeight = sizeOf(info?.windowHeight, info?.screenHeight) / scale;
  const safeArea = info?.safeArea ?? {};
  const statusBarHeight = positive(info?.statusBarHeight) / scale;

  return {
    top: Math.max(statusBarHeight, leadingEdgeInset(safeArea.top, scale, windowHeight)),
    right: trailingEdgeInset(safeArea.right, scale, windowWidth),
    bottom: trailingEdgeInset(safeArea.bottom, scale, windowHeight),
    left: leadingEdgeInset(safeArea.left, scale, windowWidth),
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

/**
 * WebView 自己的视口宽度（CSS 像素）。每次现读：PC 上用户拖动窗口会变，
 * 而单位换算正是靠它和宿主报告的窗口宽度对齐。
 */
function viewportWidth() {
  return typeof window === 'undefined' ? 0 : positive(window.innerWidth);
}

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
        applyInsets(computeInsets(await readWindowInfo(), viewportWidth()), root);
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
    const info = await readWindowInfo();
    const width = viewportWidth();
    const scale = resolveUnitScale(info, width);
    if (scale !== 1) {
      console.info(
        `[delta-unlock] 宿主按物理像素回传窗口几何（窗口宽 ${info?.windowWidth} / 视口宽 ${width}），` +
          `已按 ${scale.toFixed(2)} 倍换算成 CSS 像素`,
      );
    }
    const insets = computeInsets(info, width);
    applyInsets(insets, root);
    bindResize(readWindowInfo, root);
    return insets;
  } catch (error) {
    console.warn('[delta-unlock] 读取窗口几何信息失败，安全区退回 CSS env()', error);
    return null;
  }
}

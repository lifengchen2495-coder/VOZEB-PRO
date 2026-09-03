export const REMAKE_CONTACT_SHEET_MIN_WIDTH = 720;
export const REMAKE_CONTACT_SHEET_MIN_HEIGHT = 1280;

const TARGET_ASPECT_RATIO = 9 / 16;
const MAX_ASPECT_RATIO_LOG_ERROR = 0.01;

export function remakeContactSheetDimensionError(width: number | undefined, height: number | undefined) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !width || !height || width <= 0 || height <= 0) {
        return "缺少可验证的图片尺寸";
    }
    if (Math.abs(Math.log(width / height / TARGET_ASPECT_RATIO)) > MAX_ASPECT_RATIO_LOG_ERROR) {
        return `实际像素必须为 9:16 竖版，当前为 ${width}x${height}`;
    }
    if (width < REMAKE_CONTACT_SHEET_MIN_WIDTH || height < REMAKE_CONTACT_SHEET_MIN_HEIGHT) {
        return `实际分辨率至少需要 ${REMAKE_CONTACT_SHEET_MIN_WIDTH}x${REMAKE_CONTACT_SHEET_MIN_HEIGHT}，才能为 3×4 十二宫格保留可用的单元分辨率`;
    }
    return "";
}

// 彩蛋仅识别保存后的官方 HTTPS API 地址，不根据模型名或子串猜测供应商。
const icons = prefix => Object.fromEntries([16, 24, 32, 48, 96, 128].map(size => [size, `icons/${prefix}${size}.png`]));
export const APPEARANCES = {
  default: { id: 'default', logo: 'icons/icon-96.png', favicon: 'icons/icon-32.png', animation: 'images/tagmaid-sorting-strip.png', icons: icons('icon-') },
  deepseek: { id: 'deepseek', logo: 'icons/deepseek-96.png', favicon: 'icons/deepseek-32.png', animation: 'images/tagmaid-deepseek-sorting-strip.png', icons: icons('deepseek-') }
};

export function appearanceForEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.port && !url.username && !url.password) return APPEARANCES.deepseek;
  } catch { /* 配置缺失或无效时使用原版。 */ }
  return APPEARANCES.default;
}

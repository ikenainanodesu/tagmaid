import test from 'node:test';
import assert from 'node:assert/strict';
import { appearanceForEndpoint } from '../extension/appearance.js';

test('官方 HTTPS API 不受路径、模型和域名大小写影响', () => {
  for (const endpoint of ['https://api.deepseek.com', 'https://api.deepseek.com/v1', 'https://api.deepseek.com/chat/completions', 'https://API.DEEPSEEK.COM:443/v1/chat/completions']) {
    assert.equal(appearanceForEndpoint(endpoint).id, 'deepseek', endpoint);
  }
});

test('无效配置、第三方模型名、相似域名及嵌入地址不会触发彩蛋', () => {
  for (const endpoint of [undefined, null, '', 'deepseek-chat', 'http://api.deepseek.com', 'https://api.deepseek.com.evil.test/v1', 'https://notdeepseek.com', 'https://deepseek.com', 'https://proxy.test/deepseek', 'https://proxy.test/?endpoint=https://api.deepseek.com', 'https://api.deepseek.com@evil.test', 'https://evil.test@api.deepseek.com', 'https://api.deepseek.com:8443/v1']) {
    assert.equal(appearanceForEndpoint(endpoint).id, 'default', String(endpoint));
  }
});

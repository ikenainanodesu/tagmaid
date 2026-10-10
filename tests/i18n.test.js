import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES, resolveLanguage, translate, translations, errorMessage } from '../extension/i18n.js';
import { requestPlan } from '../extension/api.js';
import { payloadFor } from '../extension/core.js';

const snapshot = { windowId: 1, tabs: [{ id: 1, index: 0, groupId: -1, url: 'https://example.test/' }], groups: [] };

test('首次按浏览器语言匹配，手动选择优先，其他语言回退英文', () => {
  for (const [browser, expected] of [['zh-TW', 'zh-CN'], ['zh-CN', 'zh-CN'], ['ja-JP', 'ja'], ['en-GB', 'en'], ['de-DE', 'en']]) {
    assert.equal(resolveLanguage(undefined, browser), expected);
    assert.equal(resolveLanguage('invalid', browser), expected);
    for (const saved of LANGUAGES) assert.equal(resolveLanguage(saved, browser), saved);
  }
});

test('全部文案提供日英文翻译且动态参数一致', () => {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const [key, values] of Object.entries(translations)) {
    assert.equal(values.length, 2, key);
    for (const value of values) {
      assert.ok(value.trim(), key);
      assert.deepEqual(placeholders(value), placeholders(key), key);
    }
  }
});

test('界面静态标记、动态文案和应用自身错误全部覆盖翻译', async () => {
  const html = await readFile('extension/sidepanel.html', 'utf8');
  for (const [, key] of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g)) assert.ok(Object.hasOwn(translations, key), key);
  for (const file of ['sidepanel.js', 'core.js', 'api.js', 'engine.js', 'background.js']) {
    const code = await readFile(`extension/${file}`, 'utf8');
    for (const [, key] of code.matchAll(/'([^'\n]*)'/g)) {
      if (!/[\u4e00-\u9fff]/.test(key)) continue;
      // 提示词属于模型协议，不是用户界面。
      if (file === 'api.js' && ['简体中文 (Simplified Chinese)', '日本語 (Japanese)', '按主题或任务分类'].includes(key)) continue;
      assert.ok(Object.hasOwn(translations, key), `${file}: ${key}`);
    }
  }
});

test('请求明确新组名语言及附加指示优先级，保留用户原始内容', async () => {
  for (const [language, expected] of [['zh-CN', 'Simplified Chinese'], ['ja', 'Japanese'], ['en', 'English']]) {
    const instruction = '请用法语命名';
    await requestPlan({ endpoint: 'https://api.test/v1', model: 'model', language }, snapshot, 'new', instruction, undefined, async (_url, options) => {
      const { messages } = JSON.parse(options.body);
      assert.ok(messages[0].content.includes(expected));
      assert.match(messages[0].content, /附加要求明确指定组名语言，优先遵从/);
      assert.match(messages[0].content, /已有组名保持原样/);
      assert.ok(messages[1].content.includes(instruction));
      return Response.json({ choices: [{ message: { content: '{"groups":[],"ungroupedTabIds":[1]}' } }] });
    });
  }
  const original = structuredClone(snapshot);
  original.tabs[0].title = '原始 title タイトル {count}';
  for (const language of LANGUAGES) assert.equal(payloadFor(original, 'new', language).tabs[0].title, original.tabs[0].title);
  assert.equal(translate('en', '{title} 的去向', { title: original.tabs[0].title }), 'Destination for 原始 title タイトル {count}');
});

test('HTTP 与后台错误可随语言重新渲染，保留状态码及外部诊断', async () => {
  let error;
  try {
    await requestPlan({ endpoint: 'https://api.test/v1', model: 'model' }, snapshot, 'new', '', undefined, async () => new Response('', { status: 429 }));
  } catch (value) { error = value; }
  const message = errorMessage(error);
  assert.equal(translate('en', message.key, message.params), 'API request failed (429): Too many requests or insufficient quota.');
  assert.match(translate('ja', message.key, message.params), /429.*利用枠/);
  const background = errorMessage(new Error('新组名称须为 1–60 个字符。'));
  assert.equal(translate('en', background.key, background.params), 'New group names must contain 1–60 characters.');
  const external = errorMessage(new Error('No tab with id: 123'));
  assert.equal(translate('en', external.key, external.params), 'Operation failed: No tab with id: 123');
});

test('浏览器管理的扩展名称、入口与说明具有完整语言资源', async () => {
  const manifest = await readFile('extension/manifest.json', 'utf8');
  for (const locale of ['en', 'ja', 'zh_CN']) {
    const catalog = JSON.parse(await readFile(`extension/_locales/${locale}/messages.json`, 'utf8'));
    for (const [, key] of manifest.matchAll(/__MSG_(\w+)__/g)) assert.ok(catalog[key]?.message, `${locale}: ${key}`);
  }
});

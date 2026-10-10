import { readFile, access, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.ok(!manifest.host_permissions?.length);
assert.ok(!manifest.action.default_popup);
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, 'styles.css', 'sidepanel.js']) await access(`extension/${file}`);
for (const icons of [manifest.icons, manifest.action.default_icon]) {
  for (const [size, file] of Object.entries(icons ?? {})) {
    const png = await readFile(`extension/${file}`);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} 必须是 PNG`);
    assert.equal(png.readUInt32BE(16), Number(size), `${file} 宽度不符`);
    assert.equal(png.readUInt32BE(20), Number(size), `${file} 高度不符`);
  }
}
for (const file of await readdir('extension')) if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', `extension/${file}`]);
const html = await readFile('extension/sidepanel.html', 'utf8');
for (const [, file] of html.matchAll(/(?:src|href)="([^"]+)"/g)) await access(`extension/${file}`);
const ui = await readFile('extension/sidepanel.js', 'utf8');
for (const [, id] of ui.matchAll(/\$\('([^']+)'\)/g)) assert.ok(html.includes(`id="${id}"`), `缺少 UI 元素 ${id}`);
assert.ok(!html.includes('onclick='));
console.log('清单资源、脚本语法和界面引用检查通过。');

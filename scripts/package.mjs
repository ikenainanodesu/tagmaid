import { mkdir, cp, copyFile, rm, lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const target = resolve(dist, 'TagMaid');
// 只清理固定生成目录；拒绝经符号链接或目录联接越出项目。
for (const path of [dist, target]) {
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (stat?.isSymbolicLink()) throw new Error(`拒绝向链接目录打包：${path}`);
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(root, 'extension'), target, { recursive: true });
await cp(resolve(root, 'assets/screenshots'), resolve(target, 'assets/screenshots'), { recursive: true });
for (const file of ['README.md', 'README.zh-CN.md', 'README.ja.md']) {
  // 发布包中 manifest 位于根目录，修正随包文档的资源相对路径。
  const text = await readFile(resolve(root, file), 'utf8');
  await writeFile(resolve(target, file), text.replaceAll('src="extension/', 'src="').replaceAll('](extension/', ']('));
}
for (const file of ['SECURITY.md', 'LICENSE', 'NOTICE']) {
  await copyFile(resolve(root, file), resolve(target, file));
}
console.log(`已生成可直接加载的扩展目录：${target}`);

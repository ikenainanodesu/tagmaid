import { mkdir, cp, copyFile } from 'node:fs/promises';
const target = 'dist/TagMaid';
await mkdir(target, { recursive: true });
await cp('extension', target, { recursive: true });
await copyFile('README.md', `${target}/使用说明.md`);
console.log(`已生成可直接加载的扩展目录：${target}`);

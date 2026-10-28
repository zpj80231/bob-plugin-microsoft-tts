/**
 * CI 专用：在当前工作树（最新 main）上追加 appcast 条目并同步版本号
 *
 * 用法：
 *   node scripts/update-appcast.js v1.1.1
 *   VERSION=1.1.1 node scripts/update-appcast.js
 *
 * 前置条件：`release/bob-plugin-microsoft-tts-v<version>.bobplugin` 已由构建步骤产出。
 *
 * 与 `scripts/build.js` 的区别：build.js 是"在检出的 tag 上顺手更新一份 appcast"，
 * 而 release workflow 必须先把工作树切到最新 main，再调用本脚本追加条目，
 * 这样提交的父节点就是 main 头，push 才能快进，也不会丢主线上的历史条目。
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildAppcastEntry, computeSha256, upsertAppcast, writeJson} from './appcast.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const infoPath = path.join(root, 'info.json');
const pkgPath = path.join(root, 'package.json');
const appcastPath = path.join(root, 'appcast.json');
const releaseDir = path.join(root, 'release');

const version = (process.argv[2] || process.env.VERSION || '').replace(/^v/, '');
if (!version) {
    console.error('缺少版本号，用法：node scripts/update-appcast.js v1.1.1');
    process.exit(1);
}

const repository = process.env.GITHUB_REPOSITORY || 'zpj80231/bob-plugin-microsoft-tts';
const artifactPath = path.join(releaseDir, `bob-plugin-microsoft-tts-v${version}.bobplugin`);

if (!fs.existsSync(artifactPath)) {
    console.error(`找不到构建产物：${path.relative(root, artifactPath)}，请先执行构建`);
    process.exit(1);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// 1. 同步版本号到 package.json / info.json（与 build.js 的 syncVersion 行为一致）
const pkg = readJson(pkgPath);
if (pkg.version !== version) {
    pkg.version = version;
    writeJson(pkgPath, pkg);
    console.log(`Synced package.json version → ${version}`);
}

const info = readJson(infoPath);
if (info.version !== version) {
    info.version = version;
    writeJson(infoPath, info);
    console.log(`Synced info.json version → ${version}`);
}

// 2. 以当前 appcast 为基底追加条目（保留历史版本）
const appcast = readJson(appcastPath);
const entry = buildAppcastEntry({
    version,
    sha256: computeSha256(artifactPath),
    repository,
    minBobVersion: info.minBobVersion || '1.8.0',
});
const before = (appcast.versions || []).map((item) => item.version).join(', ');
const next = upsertAppcast(appcast, entry);
writeJson(appcastPath, next);

console.log(`appcast.json: [${before}] → [${next.versions.map((item) => item.version).join(', ')}]`);
console.log(`sha256: ${entry.sha256}`);

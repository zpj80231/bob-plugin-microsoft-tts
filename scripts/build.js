/**
 * 统一构建脚本
 *
 * 单次 Node 进程完成全部构建、打包和发布准备工作。
 *
 * 构建流程：
 *   1. 检测版本号（优先级：环境变量 > git tag > package.json）
 *   2. 同步版本号到 package.json 和 info.json
 *   3. esbuild 打包：src/main.ts → dist/main.js
 *   4. adm-zip 打包：info.json + icon.png + main.js → release/*.bobplugin
 *   5. 计算 SHA256（用于 appcast 校验）
 *   6. 更新根目录 appcast.json（Bob 依赖此文件判断插件更新）
 *   7. 生成 release/release-notes.md（GitHub Release 发布说明）
 *
 * 版本号检测优先级：
 *   1. VERSION 环境变量（显式指定）
 *   2. GITHUB_REF_NAME 环境变量（CI tag 触发，如 v1.0.0）
 *   3. git describe --tags --abbrev=0（当前分支最新 tag）
 *   4. package.json 的 version（兜底）
 */

import {execSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import esbuild from 'esbuild';
import AdmZip from 'adm-zip';
import {buildAppcastEntry, upsertAppcast} from './appcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');
const infoPath = path.join(root, 'info.json');
const appcastPath = path.join(root, 'appcast.json');
const changelogPath = path.join(root, 'CHANGELOG.md');
const pkgPath = path.join(root, 'package.json');

const version = detectVersion();
const tag = `v${version}`;
const repository = process.env.GITHUB_REPOSITORY || 'zpj80231/bob-plugin-microsoft-tts';
const artifactName = `bob-plugin-microsoft-tts-v${version}.bobplugin`;
const artifactPath = path.join(releaseDir, artifactName);
const notesPath = path.join(releaseDir, 'release-notes.md');

console.log(`Building version: ${version} (tag: ${tag})`);

syncVersion();
esbuildBuild();
zipBundle();
const sha256 = computeSha256();
updateAppcast();
generateReleaseNotes();

console.log();
console.log(`✅ Build complete: ${path.relative(root, artifactPath)}`);
console.log(`✅ SHA256: ${sha256}`);

/**
 * 检测版本号
 * 优先级：VERSION 环境变量 > GITHUB_REF_NAME > git tag > package.json
 * CI 中 tag 触发时 GITHUB_REF_NAME 为 "v1.0.0" 格式，会自动去掉 "v" 前缀。
 */
function detectVersion() {
    if (process.env.VERSION) {
        return process.env.VERSION.replace(/^v/, '');
    }
    if (process.env.GITHUB_REF_NAME) {
        return process.env.GITHUB_REF_NAME.replace(/^v/, '');
    }
    try {
        const gitTag = execSync('git describe --tags --abbrev=0', {
            cwd: root,
            stdio: ['pipe', 'pipe', 'pipe']
        }).toString().trim();
        return gitTag.replace(/^v/, '');
    } catch {
        const pkg = readJson(pkgPath);
        return pkg.version;
    }
}

/**
 * 同步版本号到 package.json 和 info.json
 * 确保三个文件的版本号一致：git tag / package.json / info.json
 * 当版本号已一致时跳过写入，避免不必要的文件变更。
 */
function syncVersion() {
    const pkg = readJson(pkgPath);
    const info = readJson(infoPath);

    if (pkg.version !== version) {
        pkg.version = version;
        fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
        console.log(`Synced package.json version → ${version}`);
    }

    if (info.version !== version) {
        info.version = version;
        fs.writeFileSync(infoPath, `${JSON.stringify(info, null, 2)}\n`);
        console.log(`Synced info.json version → ${version}`);
    }
}

/**
 * esbuild 打包
 * 以 src/main.ts 为入口，输出 CJS 格式的单文件 bundle 到 dist/main.js。
 * 排除 Node.js 内置模块，开启压缩和摇树优化。
 */
function esbuildBuild() {
    fs.rmSync(distDir, {recursive: true, force: true});
    fs.mkdirSync(distDir, {recursive: true});

    esbuild.buildSync({
        entryPoints: [path.join(root, 'src/main.ts')],
        outfile: path.join(distDir, 'main.js'),
        bundle: true,
        format: 'cjs',
        platform: 'neutral',
        target: ['es2018'],
        mainFields: ['main'],
        conditions: ['node', 'require', 'default'],
        external: ['node:fs', 'node:os', 'node:path', 'fs', 'os', 'path'],
        logLevel: 'info',
        legalComments: 'none',
        minify: true,
        treeShaking: true,
    });
    console.log('esbuild bundle → dist/main.js');
}

/**
 * adm-zip 打包
 * 将 info.json、icon.png（可选）、dist/main.js 打包为 .bobplugin 文件（ZIP 格式）。
 * 直接输出到 release/ 目录，不在根目录生成中间文件。
 */
function zipBundle() {
    fs.rmSync(releaseDir, {recursive: true, force: true});
    fs.mkdirSync(releaseDir, {recursive: true});

    const zip = new AdmZip();
    const requiredEntries = [
        {src: path.join(root, 'info.json'), dest: 'info.json'},
        {src: path.join(distDir, 'main.js'), dest: 'main.js'},
    ];
    const optionalEntries = [
        {src: path.join(root, 'icon.png'), dest: 'icon.png'},
    ];

    for (const {src, dest} of requiredEntries) {
        if (!fs.existsSync(src)) {
            throw new Error(`Missing required file: ${path.relative(root, src)}`);
        }
        zip.addLocalFile(src, '', dest);
    }
    for (const {src, dest} of optionalEntries) {
        if (!fs.existsSync(src)) {
            console.log(`Skipping optional file: ${path.relative(root, src)} (not found)`);
            continue;
        }
        zip.addLocalFile(src, '', dest);
    }
    zip.writeZip(artifactPath);
    console.log(`Packed → ${path.relative(root, artifactPath)}`);
}

/**
 * 计算产物的 SHA256 哈希值
 * 用于 appcast.json 中的校验字段，Bob 下载插件后会验证此值。
 */
function computeSha256() {
    return crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
}

/**
 * 更新根目录 appcast.json
 * Bob 通过读取此文件判断插件是否有新版本。
 * 同一版本号已存在时会被替换（支持重新构建）。
 */
function updateAppcast() {
    const info = readJson(infoPath);
    const appcast = readJson(appcastPath);

    const entry = buildAppcastEntry({
        version,
        sha256,
        repository,
        minBobVersion: info.minBobVersion || '1.8.0',
    });

    fs.writeFileSync(appcastPath, `${JSON.stringify(upsertAppcast(appcast, entry), null, 2)}\n`);
    console.log(`Updated appcast.json for ${tag}`);
}

/**
 * 生成 GitHub Release 发布说明
 * 从 CHANGELOG.md 提取当前版本的完整变更内容，附加下载链接和 SHA256。
 */
function generateReleaseNotes() {
    const changelogSection = extractChangelogSection(changelogPath, tag);
    const notes = [
        `## bob-plugin-microsoft-tts ${tag}`,
        '',
        changelogSection.trim(),
        '',
        '### 下载',
        '',
        `- 插件文件：\`${artifactName}\``,
        `- SHA256：\`${sha256}\``,
        '',
    ].join('\n');
    fs.writeFileSync(notesPath, notes);
    console.log(`Generated ${path.relative(root, notesPath)}`);
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * 从 CHANGELOG.md 中提取指定版本标题下的内容
 * 兼容三种格式：
 *   - 手动维护：`## v1.0.0 (2026-05-25)`
 *   - conventional-changelog 生成：`# 1.0.0 (2026-05-25)` 或 `## 1.0.0 (2026-05-25)`
 * 提取到下一个同级或更高级标题为止。
 */
function extractChangelogSection(file, heading) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const bareVersion = heading.replace(/^v/, '');
    const startPattern = new RegExp(`^#{1,2}\\s+(v?${escapeRegExp(bareVersion)})(?:\\s|$|\\()`);
    const nextPattern = /^#{1,2}\s+/;
    const section = [];
    let capture = false;

    for (const line of lines) {
        if (!capture && startPattern.test(line)) {
            capture = true;
            continue;
        }
        if (capture && nextPattern.test(line)) break;
        if (capture) section.push(line);
    }

    const text = section.join('\n').trim();
    if (!text) {
        throw new Error(`CHANGELOG.md does not contain release notes for ${heading}`);
    }
    return text;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

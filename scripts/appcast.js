/**
 * appcast.json 条目构建与更新工具
 *
 * 供两个调用方共用，避免条目格式在两处漂移：
 *   1. `scripts/build.js`：本地/单机构建时预估一次条目（仅用于把 appcast 写进产物目录）；
 *   2. `scripts/update-appcast.js`：CI 在**最新 main** 的工作树上重新计算条目并提交。
 *
 * 为什么要分开：CI 从 tag 检出构建产物，但 appcast 必须基于 main 的最新内容追加，
 * 否则 tag 不是 main 直系祖先时既 push 不上（non-fast-forward），
 * 又容易把主线上的历史版本条目覆盖掉。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * 计算文件的 SHA256
 *
 * @param {string} filePath - 文件绝对路径
 * @returns {string} 十六进制摘要
 */
export function computeSha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 构建单个版本条目
 *
 * @param {object} options - 条目参数
 * @param {string} options.version - 版本号（不带 `v` 前缀）
 * @param {string} options.sha256 - 安装包摘要
 * @param {string} options.repository - GitHub 仓库，如 `zpj80231/bob-plugin-microsoft-tts`
 * @param {string} options.minBobVersion - 要求的最低 Bob 版本
 * @returns {object} appcast 版本条目
 */
export function buildAppcastEntry({version, sha256, repository, minBobVersion}) {
    const artifactName = `bob-plugin-microsoft-tts-v${version}.bobplugin`;
    return {
        version,
        desc: `https://github.com/${repository}/blob/main/CHANGELOG.md`,
        sha256,
        url: `https://github.com/${repository}/releases/download/v${version}/${artifactName}`,
        minBobVersion,
        timestamp: Date.now(),
    };
}

/**
 * 将版本条目写入 appcast（同版本覆盖，新版本置顶）
 *
 * @param {object} appcast - 原有 appcast 对象
 * @param {object} entry - 新条目
 * @returns {object} 新的 appcast 对象（不修改入参）
 */
export function upsertAppcast(appcast, entry) {
    const versions = (appcast.versions || []).filter((item) => item.version !== entry.version);
    return {...appcast, versions: [entry, ...versions]};
}

/**
 * 以 2 空格缩进 + 结尾换行写回 JSON 文件
 *
 * @param {string} filePath - 目标文件
 * @param {unknown} value - 待写入的值
 */
export function writeJson(filePath, value) {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

import fs from 'node:fs'
import path from 'node:path'

function stripQuotes(value = '') {
    return String(value || '').trim().replace(/^['"]|['"]$/g, '')
}

function normalizePath(value) {
    if (!value) return ''
    return path.resolve(String(value))
}

export function getRuntimeRootHints() {
    const cwd = process.cwd()
    const basename = path.basename(cwd)
    const parent = path.dirname(cwd)
    const parentName = path.basename(parent)

    let botRoot = cwd
    let pluginsRoot = path.join(cwd, 'plugins')
    let pluginRoot = path.join(pluginsRoot, 'AI-Plugin')

    if (basename === 'AI-Plugin') {
        pluginRoot = cwd
        pluginsRoot = parent
        botRoot = parentName === 'plugins' ? path.dirname(parent) : parent
    }

    return {
        botRoot: normalizePath(botRoot),
        pluginsRoot: normalizePath(pluginsRoot),
        pluginRoot: normalizePath(pluginRoot)
    }
}

function includesAny(text, patterns = []) {
    return patterns.some(pattern => pattern.test(text))
}

export function inferExpectedDirectory({ userMessage = '' } = {}) {
    const roots = getRuntimeRootHints()
    const text = String(userMessage || '').toLowerCase()

    const explicitPluginIntent = includesAny(text, [
        /ai-plugin/i,
        /plugins\/ai-plugin/i,
        /(当前|这个|本|ai).{0,8}插件/i
    ])
    if (explicitPluginIntent) {
        return { expectedDirectory: roots.pluginRoot, reason: '用户指向当前 AI-Plugin 插件根目录。', allowInside: true, roots }
    }

    const allPluginsIntent = includesAny(text, [
        /机器人根目录.{0,8}(插件目录|plugins)/i,
        /(所有|全部|全体).{0,8}(插件|plugins)/i,
        /(云崽|yunzai).{0,8}(plugins|插件目录)/i,
        /\/plugins(?:\s|$|\/)/i
    ])
    if (allPluginsIntent) {
        return { expectedDirectory: roots.pluginsRoot, reason: '用户指向机器人根目录的插件目录/所有插件目录。', allowInside: false, roots }
    }

    const botRootIntent = includesAny(text, [
        /(机器人|云崽|yunzai).{0,8}(根目录|主目录|目录|root)/i,
        /\/root\/yunzai(?:\s|$|\/)/i
    ])
    if (botRootIntent) {
        return { expectedDirectory: roots.botRoot, reason: '用户指向机器人根目录。', allowInside: false, roots }
    }

    const pluginIntent = includesAny(text, [
        /插件(根目录|目录|仓库)/i,
        /(更新|拉取|pull).{0,12}插件/i,
        /插件.{0,12}(更新|拉取|pull)/i
    ])
    if (pluginIntent) {
        return { expectedDirectory: roots.pluginRoot, reason: '用户指向当前 AI-Plugin 插件根目录。', allowInside: true, roots }
    }

    return { expectedDirectory: '', reason: '', allowInside: false, roots }
}

export function commandNeedsDirectoryGuard(command = '') {
    const value = String(command || '').trim()
    if (!value) return false

    const mutatingPatterns = [
        /\bgit\s+(pull|reset|checkout|clean|merge|rebase|commit|push|stash|submodule\s+update)\b/i,
        /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|update|upgrade|run|start|dev|build|deploy)\b/i,
        /\b(?:pip|pip3|python\s+-m\s+pip)\s+install\b/i,
        /\b(?:apt|apt-get|dnf|yum|pacman|apk)\s+(?:install|remove|upgrade|update)\b/i,
        /\b(?:rm|mv|cp|chmod|chown|ln|mkdir|touch|truncate)\b/i,
        /\b(?:sed\s+-i|perl\s+-pi|tee\s+-a?)\b/i,
        /(?:^|[^<])>{1,2}\s*[^&\s]/,
        /\b(?:docker|docker-compose|podman|systemctl|service|pm2)\s+/i
    ]
    return mutatingPatterns.some(pattern => pattern.test(value))
}

function resolveCommandDirectory(rawDir, baseDir) {
    const dir = stripQuotes(rawDir)
    if (!dir) return ''
    return path.isAbsolute(dir) ? path.resolve(dir) : path.resolve(baseDir, dir)
}

export function inferCommandEffectiveDirectory(command = '', currentDirectory = process.cwd()) {
    const value = String(command || '')
    const base = normalizePath(currentDirectory || process.cwd())

    const gitCMatch = value.match(/\bgit\s+-C\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)\s+/i)
    if (gitCMatch?.[1]) {
        return resolveCommandDirectory(gitCMatch[1], base)
    }

    const cdMatch = value.match(/^\s*cd\s+((?:"[^"]+")|(?:'[^']+')|[^\s;&|]+)\s*(?:&&|;|\n)/i)
    if (cdMatch?.[1]) {
        return resolveCommandDirectory(cdMatch[1], base)
    }

    return base
}

function sameOrInside(actual, expected) {
    const actualPath = normalizePath(actual)
    const expectedPath = normalizePath(expected)
    if (!actualPath || !expectedPath) return false
    return actualPath === expectedPath || actualPath.startsWith(expectedPath + path.sep)
}

function matchesExpectedDirectory(actual, expected, allowInside = false) {
    const actualPath = normalizePath(actual)
    const expectedPath = normalizePath(expected)
    if (!actualPath || !expectedPath) return false
    if (actualPath === expectedPath) return true
    return allowInside && sameOrInside(actualPath, expectedPath)
}

export function validateShellDirectorySafety({ command = '', cwd = '', userMessage = '', toolName = 'shell_exec' } = {}) {
    const currentDirectory = normalizePath(cwd || process.cwd())
    const effectiveDirectory = inferCommandEffectiveDirectory(command, currentDirectory)
    const expected = inferExpectedDirectory({ userMessage })
    const needsGuard = commandNeedsDirectoryGuard(command)

    if (!needsGuard || !expected.expectedDirectory) {
        return {
            ok: true,
            checked: needsGuard,
            currentDirectory,
            effectiveDirectory,
            expectedDirectory: expected.expectedDirectory,
            expectedReason: expected.reason,
            allowInside: expected.allowInside
        }
    }

    if (!fs.existsSync(expected.expectedDirectory)) {
        return {
            ok: false,
            safetyBlocked: true,
            currentDirectory,
            effectiveDirectory,
            expectedDirectory: expected.expectedDirectory,
            expectedReason: expected.reason,
            allowInside: expected.allowInside,
            reason: `目录安全检查未通过：期望目录不存在（${expected.expectedDirectory}）。`
        }
    }

    if (!matchesExpectedDirectory(effectiveDirectory, expected.expectedDirectory, expected.allowInside)) {
        return {
            ok: false,
            safetyBlocked: true,
            currentDirectory,
            effectiveDirectory,
            expectedDirectory: expected.expectedDirectory,
            expectedReason: expected.reason,
            allowInside: expected.allowInside,
            reason: `目录安全检查未通过：${toolName} 准备执行会改动状态的命令，但当前/生效目录不在期望目录内。`
        }
    }

    return {
        ok: true,
        checked: true,
        currentDirectory,
        effectiveDirectory,
        expectedDirectory: expected.expectedDirectory,
        expectedReason: expected.reason,
        allowInside: expected.allowInside
    }
}

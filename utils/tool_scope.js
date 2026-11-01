export function normalizeAuthorizedToolNames(value = []) {
    const names = Array.isArray(value) ? value : []
    return [...new Set(names.map(name => String(name || '').trim()).filter(Boolean))]
}

export function checkToolAuthorizationScope(toolName = '', options = {}) {
    if (options.enforceToolScope !== true) return { allowed: true }

    const name = String(toolName || '').trim()
    const authorized = new Set(normalizeAuthorizedToolNames(options.authorizedToolNames))
    if (authorized.size === 0) {
        return {
            allowed: false,
            error: `工具 ${name || 'unknown'} 没有本轮服务端授权范围，已阻止执行。`
        }
    }
    if (!authorized.has(name)) {
        return {
            allowed: false,
            error: `工具 ${name || 'unknown'} 不在本轮用户请求授权范围内，已阻止执行。`
        }
    }
    return { allowed: true }
}

import path from 'node:path'

const TEXT_FILE_PATTERN = /(?:^|\/)(?:AGENTS\.md|README(?:\.[^.\/]+)?|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|requirements\.txt|Makefile|Dockerfile|[^\/]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|md|txt|py|sh|go|rs|java|kt|c|cc|cpp|h|hpp|vue|svelte))$/i
const SKIP_FILE_PATTERN = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|[^\/]+\.min\.(?:js|css)|dist|build|coverage|vendor)(?:\/|$)/i

function scoreSurveyFile(entry = {}) {
    const relativePath = String(entry.relativePath || entry.path || '')
    const basename = path.basename(relativePath)
    const depth = relativePath.split(/[\\/]+/).filter(Boolean).length
    let score = Math.max(0, 30 - depth * 4)
    if (/^AGENTS\.md$/i.test(basename)) score += 150
    else if (/^README/i.test(basename)) score += 140
    else if (/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|composer\.json|requirements\.txt)$/i.test(basename)) score += 130
    else if (/^(?:index|main|app|server|cli)\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java)$/i.test(basename)) score += 110
    else if (/(?:config|setting|route|plugin|loader|entry)/i.test(basename)) score += 70
    if (depth === 1) score += 35
    return score
}

export function selectWorkspaceSurveyFiles(entries = [], attemptedPaths = [], limit = 2) {
    const attempted = attemptedPaths instanceof Set ? attemptedPaths : new Set(attemptedPaths)
    const candidates = entries
        .filter(entry => entry?.type === 'file')
        .filter(entry => Number(entry.size || 0) <= 2 * 1024 * 1024)
        .filter(entry => TEXT_FILE_PATTERN.test(String(entry.relativePath || entry.path || '')))
        .filter(entry => !SKIP_FILE_PATTERN.test(String(entry.relativePath || entry.path || '')))
        .filter(entry => !attempted.has(String(entry.path || '')))
        .map(entry => ({ ...entry, surveyScore: scoreSurveyFile(entry) }))
        .sort((left, right) => right.surveyScore - left.surveyScore || String(left.relativePath).localeCompare(String(right.relativePath), 'zh-CN'))

    const selected = []
    const selectedRoots = new Set()
    for (const candidate of candidates) {
        if (selected.length >= Math.max(1, Number(limit) || 2)) break
        const segments = String(candidate.relativePath || '').split(/[\\/]+/).filter(Boolean)
        const root = segments.length > 1 ? segments[0] : '__root__'
        const duplicateRoot = selectedRoots.has(root)
        const hasAlternatives = candidates.some(other => {
            const otherSegments = String(other.relativePath || '').split(/[\\/]+/).filter(Boolean)
            const otherRoot = otherSegments.length > 1 ? otherSegments[0] : '__root__'
            return !selectedRoots.has(otherRoot) && !selected.some(item => item.path === other.path)
        })
        if (duplicateRoot && hasAlternatives) continue
        selected.push(candidate)
        selectedRoots.add(root)
    }
    if (selected.length < Math.max(1, Number(limit) || 2)) {
        for (const candidate of candidates) {
            if (selected.length >= Math.max(1, Number(limit) || 2)) break
            if (selected.some(item => item.path === candidate.path)) continue
            selected.push(candidate)
        }
    }
    return selected
}

const BRACKET_ONLY_GROUP_NAME = /^[【】\[\]（）()［］｛｝{}「」『』〈〉《》〔〕〖〗〘〙〚〛]+$/u
const BRACKET_DESCRIPTION = /(?:空|方|中|圆|小|大)?括号/u

export function scoreSymbolicGroupNameMatch(groupName = '', query = '') {
    const name = String(groupName || '').trim()
    const target = String(query || '').trim()
    if (!name || !target) return 0
    if (name.toLocaleLowerCase() === target.toLocaleLowerCase()) return 100
    if (BRACKET_ONLY_GROUP_NAME.test(name) && BRACKET_DESCRIPTION.test(target)) return 85
    return 0
}

function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
}

function asText(value) {
    return value === undefined || value === null ? '' : String(value).trim()
}

/** Normalize one independently configured model. */
export function normalizeModelDefinition(raw = {}) {
    if (!isRecord(raw)) return null

    const modelId = asText(raw.model)
    const id = asText(raw.id)
    const providerId = asText(raw.provider)
    if (!id || !modelId || !providerId) return null

    return {
        ...raw,
        id,
        alias: asText(raw.alias) || id,
        model_id: modelId,
        provider_id: providerId,
        multimodal: raw.multimodal ?? true,
        per_call: raw.per_call ?? false
    }
}

export function modelReferenceId(reference) {
    if (typeof reference === 'string' || typeof reference === 'number') return asText(reference)
    if (!isRecord(reference)) return ''
    return asText(reference.id)
}

export function resolveModelReference(reference, definitions = [], providerId = '') {
    const ref = modelReferenceId(reference)
    if (!ref) return null

    const scoped = definitions.filter(model => !providerId || model.provider_id === providerId)
    const exactId = scoped.filter(model => model.id === ref)
    if (exactId.length === 1) return exactId[0]

    const exactAlias = scoped.filter(model => model.alias === ref)
    if (exactAlias.length === 1) return exactAlias[0]

    const exactModel = scoped.filter(model => model.model_id === ref)
    if (exactModel.length === 1) return exactModel[0]

    return null
}

function normalizeGroup(group = {}, definitions, providerId = '') {
    if (!isRecord(group)) return { chat_models: [], draw_models: [] }
    const result = {}
    for (const [role, references] of Object.entries(group)) {
        if (!Array.isArray(references)) {
            result[role] = references
            continue
        }
        result[role] = references
            .map(reference => resolveModelReference(reference, definitions, providerId)?.id || modelReferenceId(reference))
            .filter(Boolean)
    }
    return result
}

function collectNewFormat(docValues) {
    const objects = docValues.filter(isRecord)
    const providers = objects.flatMap(doc => Array.isArray(doc.providers) ? doc.providers : [])
    const models = objects.flatMap(doc => Array.isArray(doc.models) ? doc.models : [])
    const modelGroups = objects
        .filter(doc => isRecord(doc.model_groups))
        .reduce((merged, doc) => ({ ...merged, ...doc.model_groups }), {})
    return { providers, models, modelGroups }
}

export function normalizeModelConfigDocuments(docValues = []) {
    const { providers: declaredProviders, models: declaredModels, modelGroups: topLevelGroups } = collectNewFormat(docValues)
    if (declaredProviders.length === 0 || declaredModels.length === 0 || Object.keys(topLevelGroups).length === 0) {
        return { providers: [], definitions: [] }
    }

    const providers = declaredProviders
        .filter(provider => isRecord(provider) && asText(provider.id))
        .map(provider => ({ ...provider, model_groups: {}, model_definitions: [] }))
    const providerById = new Map(providers.map(provider => [asText(provider.id), provider]))
    const definitions = []

    for (const rawModel of declaredModels) {
        const definition = normalizeModelDefinition(rawModel)
        if (!definition) continue
        const provider = providerById.get(definition.provider_id)
        if (!provider) continue
        if (definitions.some(model => model.id === definition.id && model.provider_id === definition.provider_id)) continue
        definitions.push(definition)
        provider.model_definitions.push(definition)
    }

    for (const [groupName, group] of Object.entries(topLevelGroups)) {
        for (const provider of providers) {
            const scopedReferences = ['chat_models', 'draw_models']
                .map(role => [role, Array.isArray(group?.[role]) ? group[role].filter(reference => resolveModelReference(reference, definitions, asText(provider.id)) !== null) : []])
                .filter(([, references]) => references.length > 0)
            if (scopedReferences.length > 0) {
                provider.model_groups[groupName] = {
                    ...(provider.model_groups[groupName] || {}),
                    ...Object.fromEntries(scopedReferences.map(([role, references]) => [role, references.map(reference => resolveModelReference(reference, definitions, asText(provider.id)).id)]))
                }
            }
        }
    }

    return { providers, definitions }
}

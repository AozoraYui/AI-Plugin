function isRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
}

function asText(value) {
    return value === undefined || value === null ? '' : String(value).trim()
}

/** Normalize one independently configured model. */
export function normalizeModelDefinition(raw = {}, fallbackId = '', defaultProviderId = '') {
    if (typeof raw === 'string') raw = { model_id: raw }
    if (!isRecord(raw)) return null

    const modelId = asText(raw.model_id ?? raw.model_identifier ?? raw.model ?? raw.name ?? raw.id)
    const id = asText(raw.id ?? raw.key ?? fallbackId) || modelId
    const providerId = asText(raw.provider_id ?? raw.provider ?? raw.api_provider ?? defaultProviderId)
    if (!id || !modelId || !providerId) return null

    return {
        ...raw,
        id,
        alias: asText(raw.alias ?? raw.name ?? id) || id,
        model_id: modelId,
        provider_id: providerId,
        multimodal: raw.multimodal ?? raw.visual ?? true,
        per_call: raw.per_call ?? raw.perCall ?? false
    }
}

export function modelReferenceId(reference) {
    if (typeof reference === 'string' || typeof reference === 'number') return asText(reference)
    if (!isRecord(reference)) return ''
    return asText(reference.id ?? reference.key ?? reference.alias ?? reference.model_id ?? reference.model_identifier ?? reference.model)
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

/**
 * Convert both supported YAML layouts into the provider-shaped runtime layout.
 * The rest of the plugin can therefore keep using provider.model_groups.
 */
export function normalizeModelConfigDocuments(docValues = []) {
    const arrayDocs = docValues.filter(Array.isArray)
    const { providers: declaredProviders, models: declaredModels, modelGroups: topLevelGroups } = collectNewFormat(docValues)
    const hasIndependentModels = declaredProviders.length > 0 || declaredModels.length > 0 || Object.keys(topLevelGroups).length > 0

    if (!hasIndependentModels) {
        const providers = arrayDocs
            .flat()
            .filter(provider => isRecord(provider) && isRecord(provider.model_groups))
            .map(provider => {
                const providerId = asText(provider.id)
                const definitions = []
                const modelGroups = {}
                for (const [groupName, group] of Object.entries(provider.model_groups || {})) {
                    modelGroups[groupName] = normalizeGroup(group, definitions, providerId)
                    for (const role of ['chat_models', 'draw_models']) {
                        for (const modelId of group?.[role] || []) {
                            const reference = modelReferenceId(modelId)
                            if (!reference || definitions.some(model => model.id === reference)) continue
                            const definition = normalizeModelDefinition({
                                id: reference,
                                model_id: reference,
                                provider_id: providerId,
                                multimodal: provider.multimodal,
                                per_call: Array.isArray(provider.per_call_models) && provider.per_call_models.includes(reference)
                            })
                            if (definition) definitions.push(definition)
                        }
                    }
                }
                return {
                    ...provider,
                    model_groups: modelGroups,
                    model_definitions: definitions
                }
            })
        return { providers, definitions: providers.flatMap(provider => provider.model_definitions || []), legacy: true }
    }

    const providers = declaredProviders
        .filter(isRecord)
        .map(provider => ({ ...provider, model_groups: isRecord(provider.model_groups) ? provider.model_groups : {}, model_definitions: [] }))
    const providerById = new Map(providers.map(provider => [asText(provider.id), provider]))
    const definitions = []

    for (const [index, rawModel] of declaredModels.entries()) {
        const definition = normalizeModelDefinition(rawModel, `model-${index + 1}`)
        if (!definition) continue
        const provider = providerById.get(definition.provider_id)
        if (!provider) continue
        if (definitions.some(model => model.id === definition.id && model.provider_id === definition.provider_id)) continue
        definitions.push(definition)
        provider.model_definitions.push(definition)
    }

    const addGroups = (providerId, groups) => {
        const provider = providerById.get(providerId)
        if (!provider || !isRecord(groups)) return
        for (const [groupName, group] of Object.entries(groups)) {
            provider.model_groups[groupName] = normalizeGroup(group, definitions, providerId)
        }
    }

    for (const provider of providers) addGroups(asText(provider.id), provider.model_groups)
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

    return { providers, definitions, legacy: false }
}

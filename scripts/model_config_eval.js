import assert from 'node:assert/strict'
import yaml from 'yaml'
import { normalizeModelConfigDocuments, resolveModelReference } from '../utils/model_config.js'

const newFormat = yaml.parse(`
providers:
  - id: p1
    name: Provider 1
    base_url: https://one.example/v1
  - id: p2
    name: Provider 2
    base_url: https://two.example/v1
models:
  - id: vendor/vision
    alias: qwen-vl
    provider: p1
    multimodal: true
  - id: vendor/text
    alias: deepseek
    provider: p1
    multimodal: false
  - id: vendor/text
    alias: same
    provider: p2
    multimodal: true
model_groups:
  flash:
    chat_models: [qwen-vl, deepseek]
    draw_models: []
`)

const normalized = normalizeModelConfigDocuments([newFormat])
assert.equal(normalized.providers.length, 2)
assert.equal(normalized.definitions.length, 3)
assert.deepEqual(normalized.providers[0].model_groups.flash.chat_models, ['vendor/vision', 'vendor/text'])
assert.equal(resolveModelReference('qwen-vl', normalized.definitions, 'p1').model_id, 'vendor/vision')
assert.equal(resolveModelReference('vendor/text', normalized.definitions, 'p1').alias, 'deepseek')
assert.equal(resolveModelReference('vendor/text', normalized.definitions, 'p2').alias, 'same')
assert.equal(normalized.definitions.find(model => model.alias === 'deepseek').multimodal, false)
assert.equal(normalized.definitions.find(model => model.alias === 'same').multimodal, true)

const stringBoolean = normalizeModelConfigDocuments([{
    providers: [{ id: 'p4', name: 'Provider 4' }],
    models: [{ id: 'text-api', alias: 'text-4', provider: 'p4', multimodal: 'false', per_call: 'true' }],
    model_groups: { flash: { chat_models: ['text-4'] } }
}])
assert.equal(stringBoolean.definitions[0].multimodal, false)
assert.equal(stringBoolean.definitions[0].per_call, true)
assert.equal(stringBoolean.definitions[0].model_id, 'text-api')

const stringReference = normalizeModelConfigDocuments([{
    providers: [{ id: 'p3', name: 'Provider 3' }],
    models: [{ id: 'vision-api', alias: 'vision-3', provider: 'p3' }],
    model_groups: { flash: { chat_models: ['vision-3'] } }
}])
assert.equal(stringReference.providers[0].model_groups.flash.chat_models[0], 'vision-api')

const legacyModelField = normalizeModelConfigDocuments([{
    providers: [{ id: 'legacy-provider' }],
    models: [{ id: 'local-id', alias: 'legacy', provider: 'legacy-provider', model: 'upstream-name' }],
    model_groups: { flash: { chat_models: ['legacy'] } }
}])
assert.equal(legacyModelField.definitions.length, 0)

const oldFormat = normalizeModelConfigDocuments([{
    legacy: true,
    model_groups: { flash: { chat_models: ['legacy-text'] } }
}])
assert.equal(oldFormat.providers.length, 0)

console.log('模型配置评估通过：新版供应商、模型、别名与模型级能力均正常。')

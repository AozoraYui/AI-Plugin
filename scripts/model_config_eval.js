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
  - id: vision
    alias: qwen-vl
    provider: p1
    model: vendor/vision
    multimodal: true
  - id: text
    alias: deepseek
    provider: p1
    model: vendor/text
    multimodal: false
  - id: duplicate
    alias: same
    provider: p2
    model: vendor/text
    multimodal: true
model_groups:
  flash:
    chat_models: [qwen-vl, deepseek]
    draw_models: []
`)

const normalized = normalizeModelConfigDocuments([newFormat])
assert.equal(normalized.providers.length, 2)
assert.equal(normalized.definitions.length, 3)
assert.deepEqual(normalized.providers[0].model_groups.flash.chat_models, ['vision', 'text'])
assert.equal(resolveModelReference('qwen-vl', normalized.definitions, 'p1').model_id, 'vendor/vision')
assert.equal(resolveModelReference('vendor/text', normalized.definitions, 'p1').id, 'text')
assert.equal(resolveModelReference('vendor/text', normalized.definitions, 'p2').id, 'duplicate')
assert.equal(normalized.definitions.find(model => model.id === 'text').multimodal, false)
assert.equal(normalized.definitions.find(model => model.id === 'duplicate').multimodal, true)

const stringBoolean = normalizeModelConfigDocuments([{
    providers: [{ id: 'p4', name: 'Provider 4' }],
    models: [{ id: 'text-4', provider: 'p4', model: 'text-api', multimodal: 'false', per_call: 'true' }],
    model_groups: { flash: { chat_models: ['text-4'] } }
}])
assert.equal(stringBoolean.definitions[0].multimodal, false)
assert.equal(stringBoolean.definitions[0].per_call, true)

const stringReference = normalizeModelConfigDocuments([{
    providers: [{ id: 'p3', name: 'Provider 3' }],
    models: [{ id: 'vision-3', provider: 'p3', model: 'vision-api' }],
    model_groups: { flash: { chat_models: ['vision-3'] } }
}])
assert.equal(stringReference.providers[0].model_groups.flash.chat_models[0], 'vision-3')

const oldFormat = normalizeModelConfigDocuments([{
    legacy: true,
    model_groups: { flash: { chat_models: ['legacy-text'] } }
}])
assert.equal(oldFormat.providers.length, 0)

console.log('模型配置评估通过：新版供应商、模型、别名与模型级能力均正常。')

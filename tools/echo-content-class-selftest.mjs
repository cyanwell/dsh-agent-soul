import assert from 'node:assert/strict'
import { classifyEchoWordContent, ECHO_CONTENT_CLASSES, ECHO_INJECTION_PREFIXES } from '../src/db/echo-content-class.mjs'

assert.deepEqual(ECHO_CONTENT_CLASSES, ['dialogue', 'injection', 'other'])
assert.equal(classifyEchoWordContent({ text: 'Current runtime context\nprivate', role: 'user' }), 'injection')
assert.equal(classifyEchoWordContent({ text: 'This is an automatically generated checkpoint…', role: 'assistant' }), 'injection')
assert.equal(classifyEchoWordContent({ text: '[EAC design template: x]', role: 'assistant' }), 'injection')
assert.equal(classifyEchoWordContent({ text: '<system-reminder>hidden</system-reminder>', role: 'assistant' }), 'injection')
assert.equal(classifyEchoWordContent({ text: 'ordinary', role: 'user' }), 'dialogue')
assert.equal(classifyEchoWordContent({ text: 'ordinary', role: 'assistant' }), 'dialogue')
assert.equal(classifyEchoWordContent({ text: 'ordinary', role: 'system' }), 'other')
assert.equal(classifyEchoWordContent({ text: 'ordinary partial', role: 'user', truncated: true }), 'other')
assert.equal(classifyEchoWordContent({ text: 'Current runtime context partial', role: 'user', truncated: true }), 'injection')
assert.equal(classifyEchoWordContent({ text: 'current runtime context', role: 'user' }), 'dialogue')
assert.equal(classifyEchoWordContent({ text: ' Current runtime context', role: 'assistant' }), 'dialogue')
assert.equal(classifyEchoWordContent({ text: 'This is an automatically generated checkpointish', role: 'user' }), 'injection')
for (const prefix of ECHO_INJECTION_PREFIXES) assert.equal(classifyEchoWordContent({ text: prefix, role: 'user' }), 'injection')
console.log('echo-content-class-selftest: 10 assertions passed')

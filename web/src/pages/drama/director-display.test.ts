import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueBody, formatSeconds, groupScriptScenes, humanName, readableText, shotDisplayText } from './director-display';

test('adjacent dialogue blocks share a scene, but returning to a location preserves story order and block IDs', () => {
    const blocks = [
        { id: 'action-1', scene_id: 'hall', scene_name: 'Hall', text: 'She enters.' },
        { id: 'dialogue-1', scene_id: 'hall', speaker: '黎希', text: '黎希：你来了。' },
        { id: 'action-2', scene_id: 'arena', text: 'He falls.' },
        { id: 'action-3', scene_id: 'hall', text: 'She turns.' },
    ];
    const snapshot = JSON.stringify(blocks);
    const groups = groupScriptScenes(blocks);
    assert.deepEqual(groups.map(group => group.key), ['action-1', 'action-2', 'action-3']);
    assert.deepEqual(groups.map(group => group.blocks.map(block => block.id)), [['action-1', 'dialogue-1'], ['action-2'], ['action-3']]);
    assert.equal(groups[0].blocks[1], blocks[1]);
    assert.equal(JSON.stringify(blocks), snapshot);
});

test('read view removes only a matching speaker prefix without rewriting saved dialogue', () => {
    const block = { speaker: '黎希', text: '黎希：你来了。\n别动。' };
    assert.equal(dialogueBody(block), '你来了。\n别动。');
    assert.equal(block.text, '黎希：你来了。\n别动。');
    assert.equal(dialogueBody({ speaker: '黎希', text: '旁白：她没有回头。' }), '旁白：她没有回头。');
});

test('unknown structured state does not become editable JSON or a fake description', () => {
    assert.equal(readableText({ characters: { CHAR_A: { ammo: 0 } } }), '');
    assert.equal(readableText({ description: 'Hold the horizon.', lens_mm: 28 }), 'Hold the horizon.');
    assert.equal(readableText(['CHAR_A', 'SCENE_A'], { CHAR_A: '张伟', SCENE_A: '大殿' }), '张伟 · 大殿');
    assert.equal(humanName('SHOT_001', 'SHOT_001', '镜头 1'), '镜头 1');
    assert.equal(humanName('开场 · 远景', 'SHOT_001', '镜头 1'), '开场 · 远景');
});

test('shot cards prefer the Chinese display summary while preserving the compiler visual as fallback', () => {
    assert.equal(shotDisplayText({ display_summary: '她把信放进抽屉。', visual: 'The woman places the letter in the drawer.' }), '她把信放进抽屉。');
    assert.equal(shotDisplayText({ visual: 'The woman places the letter in the drawer.' }), 'The woman places the letter in the drawer.');
});

test('missing timing is distinct from a valid zero timestamp', () => {
    assert.equal(formatSeconds(0), '0');
    assert.equal(formatSeconds(33 / 24), '1.4');
    for (const value of [null, undefined, '', NaN, -1]) assert.equal(formatSeconds(value), '—');
});

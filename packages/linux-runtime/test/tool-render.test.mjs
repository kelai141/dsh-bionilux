import test from 'node:test';
import assert from 'node:assert/strict';
import { registerLinuxSession } from '../lib/index.js';

test('long build metadata reaches the model through the tool text renderer', async () => {
  let tool;
  const registry = { start: async () => ({ job: 'build-1', nextOffset: 32, running: true }) };
  const dispose = registerLinuxSession({ tools: { register: value => { tool = value; return () => {}; } } }, {}, { registry });
  const result = await tool.execute({ action: 'start', session: 'build', command: 'make -j8' });
  const text = tool.output.render({}, result).map(item => item.text).join('\n');
  assert.match(text, /"job":"build-1"/);
  assert.match(text, /"nextOffset":32/);
  assert.match(text, /"running":true/);
  dispose();
});

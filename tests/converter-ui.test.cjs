'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('legacy converter URL leads directly to the single-screen studio', () => {
  const html = fs.readFileSync(path.join(__dirname, '../convert.html'), 'utf8');
  assert.match(html, /http-equiv="refresh" content="0;url=\.\/#upload-score"/);
  assert.match(html, /href="\.\/#upload-score"/);
  assert.doesNotMatch(html, /converter\.js|type="file"|YouTube|Love For Duty/);
});

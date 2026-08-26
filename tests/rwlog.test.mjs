import assert from 'node:assert/strict';
import { crc32, inspectRwlog } from '../src/rwlog.js';

const te = new TextEncoder();

function makeRwlog({ version = 41, motorCmdSecond = 0 } = {}) {
  const headerSize = 110;
  const sampleSize = 146;
  const sampleCount = 2;
  const metadata = te.encode(JSON.stringify({
    format_version: version,
    measurement_mode: 'manual_passive_free_decay',
    passive_capture_mode: true,
    q_run_mode: 'none',
    angle_reference_policy: 'video_must_use_body_line_minus_fixed_horizon'
  }));
  const samplesOffset = headerSize + metadata.length;
  const crcOffset = samplesOffset + sampleSize * sampleCount;
  const data = new Uint8Array(crcOffset + 4);
  const view = new DataView(data.buffer);

  data.set(te.encode('RWLOG01'), 0);
  view.setUint16(8, version, true);
  view.setUint16(10, headerSize, true);
  view.setUint32(12, 1, true);
  view.setBigUint64(16, 123456789n, true);
  view.setUint32(24, metadata.length, true);
  view.setUint32(28, sampleCount, true);
  view.setUint32(32, 0, true);
  view.setUint32(36, 0, true);
  view.setUint16(40, sampleSize, true);
  view.setUint16(42, 0, true);
  view.setUint16(44, 0, true);
  view.setUint16(46, 20, true);
  view.setUint16(48, 5, true);
  view.setUint16(50, 20, true);
  view.setUint16(52, 500, true);
  view.setUint16(54, 1, true);
  view.setUint16(56, 32, true);
  view.setUint32(58, 1, true);
  view.setUint32(62, samplesOffset, true);
  view.setUint32(66, crcOffset, true);
  view.setUint32(70, crcOffset, true);
  view.setUint32(74, crcOffset, true);
  data.set(metadata, headerSize);

  const first = samplesOffset;
  const second = samplesOffset + sampleSize;
  view.setUint32(first, 1_000, true);
  view.setUint32(first + 4, 0, true);
  view.setUint32(second, 21_000, true);
  view.setUint32(second + 4, 20, true);
  view.setInt16(second + 15, motorCmdSecond, true);

  view.setUint32(crcOffset, crc32(data, crcOffset), true);
  return data.buffer;
}

{
  const info = inspectRwlog(makeRwlog());
  assert.equal(info.format_version, 41);
  assert.equal(info.crc.ok, true);
  assert.equal(info.time_range.log_duration_ms, 20);
  assert.equal(info.time_range.t_test_duration_ms, 20);
  assert.equal(info.decoder.status, 'decoded');
  assert.equal(info.decoder.details.passive_audit.status, 'PASS');
  assert.equal(info.decoder.details.passive_audit.nonzero_motor_cmd_samples, 0);
}

{
  const info = inspectRwlog(makeRwlog({ motorCmdSecond: 12 }));
  assert.equal(info.crc.ok, true);
  assert.equal(info.decoder.details.passive_audit.status, 'FAIL');
  assert.equal(info.decoder.details.passive_audit.nonzero_motor_cmd_samples, 1);
  assert.equal(info.decoder.details.passive_audit.max_abs_motor_cmd_mA, 12);
}

{
  const info = inspectRwlog(makeRwlog({ version: 99 }));
  assert.equal(info.format_version, 99);
  assert.equal(info.crc.ok, true);
  assert.equal(info.support, 'common-header');
  assert.equal(info.decoder.status, 'not-installed');
  assert.equal(info.time_range.pair_duration_ms, 20);
}

{
  const raw = te.encode('NOTRWLOG');
  const info = inspectRwlog(raw.buffer);
  assert.equal(info.support, 'opaque');
}

console.log('RWLOG compatibility tests passed');

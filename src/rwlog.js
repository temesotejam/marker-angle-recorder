const RWLOG_MAGIC = 'RWLOG01';
const COMMON_HEADER_MIN = 78;
const UINT32_WRAP = 2 ** 32;

const decoders = new Map();

export function registerRwlogDecoder(version, decoder) {
  if (!Number.isInteger(version) || typeof decoder !== 'function') throw new TypeError('registerRwlogDecoder(version, decoder) requires an integer version and function');
  decoders.set(version, decoder);
}

function readAscii(bytes, start, length) {
  let out = '';
  for (let i = start; i < Math.min(bytes.length, start + length); i++) {
    if (bytes[i] === 0) break;
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crcTable();

export function crc32(bytes, end = bytes.length) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function safeGet(view, method, offset, littleEndian = true) {
  const size = method.includes('Big') ? 8 : method.includes('32') ? 4 : method.includes('16') ? 2 : 1;
  if (offset < 0 || offset + size > view.byteLength) return null;
  try {
    const value = view[method](offset, littleEndian);
    return typeof value === 'bigint' ? Number(value) : value;
  } catch {
    return null;
  }
}

function commonHeader(view, magic) {
  return {
    magic,
    format_version: safeGet(view, 'getUint16', 8),
    header_size: safeGet(view, 'getUint16', 10),
    run_id: safeGet(view, 'getUint32', 12),
    run_start_us: safeGet(view, 'getBigUint64', 16),
    metadata_json_size: safeGet(view, 'getUint32', 24),
    sample_count: safeGet(view, 'getUint32', 28),
    summary_count: safeGet(view, 'getUint32', 32),
    event_count: safeGet(view, 'getUint32', 36),
    log_sample_size: safeGet(view, 'getUint16', 40),
    summary_row_size: safeGet(view, 'getUint16', 42),
    event_row_size: safeGet(view, 'getUint16', 44),
    log_period_ms: safeGet(view, 'getUint16', 46),
    imu_period_ms: safeGet(view, 'getUint16', 48),
    roller_read_period_ms: safeGet(view, 'getUint16', 50),
    web_update_period_ms: safeGet(view, 'getUint16', 52),
    total_trials: safeGet(view, 'getUint16', 54),
    preset_id: safeGet(view, 'getUint16', 56),
    flags: safeGet(view, 'getUint32', 58),
    samples_offset: safeGet(view, 'getUint32', 62),
    summaries_offset: safeGet(view, 'getUint32', 66),
    events_offset: safeGet(view, 'getUint32', 70),
    crc_offset: safeGet(view, 'getUint32', 74),
  };
}

function readMetadata(bytes, header) {
  if (!Number.isFinite(header.header_size) || !Number.isFinite(header.metadata_json_size)) return null;
  const start = header.header_size, end = start + header.metadata_json_size;
  if (start < 0 || end > bytes.length || end < start) return null;
  try {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(start, end));
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function wrappedUint32Delta(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  return last >= first ? last - first : UINT32_WRAP - first + last;
}

function sampleTimeRange(view, header) {
  const count = header.sample_count, size = header.log_sample_size, offset = header.samples_offset;
  if (!Number.isFinite(count) || !Number.isFinite(size) || !Number.isFinite(offset) || count < 1 || size < 8) return null;
  const first = offset, last = offset + (count - 1) * size;
  if (first < 0 || last + 8 > view.byteLength) return null;
  // Project RWLOG layouts so far share uint32 time_us + uint32 t_test_ms as the first 8 bytes.
  // This prefix is opportunistic: failure never blocks preservation/export.
  const firstUs = safeGet(view, 'getUint32', first), lastUs = safeGet(view, 'getUint32', last);
  const firstTestMs = safeGet(view, 'getUint32', first + 4), lastTestMs = safeGet(view, 'getUint32', last + 4);
  const logUs = wrappedUint32Delta(firstUs, lastUs);
  const testMs = wrappedUint32Delta(firstTestMs, lastTestMs);
  if (!Number.isFinite(logUs) && !Number.isFinite(testMs)) return null;
  return {
    source: 'sample-prefix',
    log_first_us: firstUs,
    log_last_us: lastUs,
    log_duration_ms: Number.isFinite(logUs) ? logUs / 1000 : null,
    t_test_first_ms: firstTestMs,
    t_test_last_ms: lastTestMs,
    t_test_duration_ms: Number.isFinite(testMs) ? testMs : null,
    pair_duration_ms: Number.isFinite(logUs) ? logUs / 1000 : (Number.isFinite(testMs) ? testMs : null),
  };
}

function estimatedDuration(header) {
  if (Number.isFinite(header.sample_count) && header.sample_count > 1 && Number.isFinite(header.log_period_ms) && header.log_period_ms > 0) {
    const duration = (header.sample_count - 1) * header.log_period_ms;
    return { source: 'header-period-estimate', log_duration_ms: duration, t_test_duration_ms: null, pair_duration_ms: duration };
  }
  return null;
}

function v41PassiveAudit(arrayBuffer, header, metadata) {
  const contract = { header_size_110: header.header_size === 110, sample_size_146: header.log_sample_size === 146 };
  const isPassive = metadata?.passive_capture_mode === true || String(metadata?.measurement_mode || '').includes('passive') || String(metadata?.measurement_goal || '').includes('passive');
  if (!isPassive || !contract.sample_size_146) return { profile: 'rwlog-v41-146', contract, passive_audit: null };

  const view = new DataView(arrayBuffer), count = header.sample_count, size = header.log_sample_size, start = header.samples_offset;
  const audit = {
    sample_count_checked: 0,
    nonzero_motor_cmd_samples: 0,
    nonzero_current_setting_samples: 0,
    pulse_active_samples: 0,
    nonzero_pulse_id_samples: 0,
    max_abs_motor_cmd_mA: 0,
    max_abs_current_setting_mA: 0,
    metadata_passive_capture_mode: metadata?.passive_capture_mode ?? null,
    metadata_q_run_mode: metadata?.q_run_mode ?? null,
    status: 'CHECK',
  };

  if (!Number.isFinite(count) || !Number.isFinite(start)) return { profile: 'rwlog-v41-146', contract, passive_audit: audit };
  for (let i = 0; i < count; i++) {
    const off = start + i * size;
    if (off < 0 || off + 23 > view.byteLength) break;
    // Stable packed prefix: time_us, t_test_ms, state_id, pulse_id, pulse_active,
    // pulse_direction, motor_cmd_mA, current_mA_setting, pulse_width_ms_setting, input_interval_ms.
    const pulseId = view.getUint32(off + 9, true);
    const pulseActive = view.getUint8(off + 13);
    const motorCmd = view.getInt16(off + 15, true);
    const currentSetting = view.getInt16(off + 17, true);
    audit.sample_count_checked++;
    if (pulseId !== 0) audit.nonzero_pulse_id_samples++;
    if (pulseActive !== 0) audit.pulse_active_samples++;
    if (motorCmd !== 0) audit.nonzero_motor_cmd_samples++;
    if (currentSetting !== 0) audit.nonzero_current_setting_samples++;
    audit.max_abs_motor_cmd_mA = Math.max(audit.max_abs_motor_cmd_mA, Math.abs(motorCmd));
    audit.max_abs_current_setting_mA = Math.max(audit.max_abs_current_setting_mA, Math.abs(currentSetting));
  }

  const sampleSafe = audit.sample_count_checked === count && audit.nonzero_motor_cmd_samples === 0 && audit.nonzero_current_setting_samples === 0 && audit.pulse_active_samples === 0 && audit.nonzero_pulse_id_samples === 0;
  const metaSafe = metadata?.passive_capture_mode === true && metadata?.q_run_mode === 'none';
  const metaUnsafe = metadata?.passive_capture_mode === false || (metadata?.q_run_mode != null && metadata.q_run_mode !== 'none');
  audit.status = sampleSafe && metaSafe ? 'PASS' : (!sampleSafe || metaUnsafe ? 'FAIL' : 'CHECK');
  return { profile: 'rwlog-v41-146', contract, passive_audit: audit };
}

registerRwlogDecoder(41, v41PassiveAudit);

export function inspectRwlog(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer), view = new DataView(arrayBuffer), magic = readAscii(bytes, 0, 8);
  const result = {
    kind: 'rwlog', support: 'opaque', magic, format_version: null, header: null, metadata: null,
    crc: { available: false, ok: null, stored: null, computed: null }, time_range: null, decoder: null, warnings: [],
  };

  if (magic !== RWLOG_MAGIC) {
    result.warnings.push(`Unknown magic: ${magic || '(empty)'}. File will still be preserved unchanged.`);
    return result;
  }
  if (bytes.length < COMMON_HEADER_MIN) {
    result.support = 'magic-only'; result.warnings.push('RWLOG01 detected, but the file is shorter than the common header prefix.'); return result;
  }

  const header = commonHeader(view, magic);
  result.support = 'common-header'; result.header = header; result.format_version = header.format_version; result.metadata = readMetadata(bytes, header);

  if (Number.isFinite(header.crc_offset) && header.crc_offset >= 0 && header.crc_offset + 4 <= bytes.length) {
    const stored = safeGet(view, 'getUint32', header.crc_offset), computed = crc32(bytes, header.crc_offset);
    result.crc = { available: true, ok: stored === computed, stored, computed };
  }
  result.time_range = sampleTimeRange(view, header) || estimatedDuration(header);

  const decoder = decoders.get(header.format_version);
  if (decoder) {
    try {
      result.decoder = { version: header.format_version, status: 'decoded', details: decoder(arrayBuffer, header, result.metadata) };
      result.support = 'version-decoded';
    } catch (error) {
      result.decoder = { version: header.format_version, status: 'decoder-error', error: String(error) };
      result.warnings.push(`Version decoder failed: ${String(error)}`);
    }
  } else {
    result.decoder = { version: header.format_version, status: 'not-installed' };
    result.warnings.push(`No detailed decoder for RWLOG v${header.format_version}; common-header checks remain available.`);
  }
  return result;
}

export function rwlogCompatibilityLabel(info) {
  if (info.support === 'version-decoded') return `v${info.format_version} known contract`;
  if (info.support === 'common-header') return `v${info.format_version ?? '?'} common header`;
  if (info.support === 'magic-only') return 'RWLOG01 magic only';
  return 'opaque file';
}

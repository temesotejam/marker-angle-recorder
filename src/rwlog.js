const RWLOG_MAGIC = 'RWLOG01';
const COMMON_HEADER_MIN = 78;

const decoders = new Map();

export function registerRwlogDecoder(version, decoder) {
  if (!Number.isInteger(version) || typeof decoder !== 'function') {
    throw new TypeError('registerRwlogDecoder(version, decoder) requires an integer version and function');
  }
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
  const start = header.header_size;
  const end = start + header.metadata_json_size;
  if (start < 0 || end > bytes.length || end < start) return null;
  try {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(start, end));
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

function sampleTimeRange(view, header) {
  const count = header.sample_count;
  const size = header.log_sample_size;
  const offset = header.samples_offset;
  if (!Number.isFinite(count) || !Number.isFinite(size) || !Number.isFinite(offset) || count < 1 || size < 8) return null;
  const first = offset;
  const last = offset + (count - 1) * size;
  if (first < 0 || last + 8 > view.byteLength) return null;
  // Every RWLOG sample layout used by this project so far starts with time_us, t_test_ms.
  // Treat this as an opportunistic prefix read, never as a requirement for accepting the file.
  const firstMs = safeGet(view, 'getUint32', first + 4);
  const lastMs = safeGet(view, 'getUint32', last + 4);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs < firstMs) return null;
  return { first_ms: firstMs, last_ms: lastMs, duration_ms: lastMs - firstMs, source: 'sample-prefix' };
}

function estimatedDuration(header) {
  if (Number.isFinite(header.sample_count) && header.sample_count > 1 && Number.isFinite(header.log_period_ms) && header.log_period_ms > 0) {
    return { duration_ms: (header.sample_count - 1) * header.log_period_ms, source: 'header-period-estimate' };
  }
  return null;
}

export function inspectRwlog(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const magic = readAscii(bytes, 0, 8);
  const result = {
    kind: 'rwlog',
    support: 'opaque',
    magic,
    format_version: null,
    header: null,
    metadata: null,
    crc: { available: false, ok: null, stored: null, computed: null },
    time_range: null,
    decoder: null,
    warnings: [],
  };

  if (magic !== RWLOG_MAGIC) {
    result.warnings.push(`Unknown magic: ${magic || '(empty)'}. File will still be preserved unchanged.`);
    return result;
  }

  if (bytes.length < COMMON_HEADER_MIN) {
    result.support = 'magic-only';
    result.warnings.push('RWLOG01 detected, but the file is shorter than the common header prefix.');
    return result;
  }

  const header = commonHeader(view, magic);
  result.support = 'common-header';
  result.header = header;
  result.format_version = header.format_version;
  result.metadata = readMetadata(bytes, header);

  if (Number.isFinite(header.crc_offset) && header.crc_offset >= 0 && header.crc_offset + 4 <= bytes.length) {
    const stored = safeGet(view, 'getUint32', header.crc_offset);
    const computed = crc32(bytes, header.crc_offset);
    result.crc = { available: true, ok: stored === computed, stored, computed };
  }

  result.time_range = sampleTimeRange(view, header) || estimatedDuration(header);

  const decoder = decoders.get(header.format_version);
  if (decoder) {
    try {
      result.decoder = { version: header.format_version, status: 'decoded', details: decoder(arrayBuffer, header) };
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
  if (info.support === 'version-decoded') return `v${info.format_version} detailed`;
  if (info.support === 'common-header') return `v${info.format_version ?? '?'} common header`;
  if (info.support === 'magic-only') return 'RWLOG01 magic only';
  return 'opaque file';
}

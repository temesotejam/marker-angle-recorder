# RWLOG compatibility strategy

The recorder must never become unusable only because firmware introduced a new RWLOG sample layout.

## Current known contract: v41

The current V62-derived passive logger uses:

```text
[110 B header]
[UTF-8 JSON metadata]
[146 B × sample_count]
[4 B CRC32]
```

- magic: `RWLOG01`
- endian: little-endian
- format version: `41`
- log period: `20 ms`
- IMU update period: `5 ms`
- CRC coverage: header + metadata + all samples, excluding the trailing CRC field

The recorder treats v41 as a known binary contract without conflating it with firmware/control names such as V62.

### v41 passive safety audit

When metadata identifies a passive capture, all samples are checked using the stable packed command prefix:

- `motor_cmd_mA == 0`
- `current_mA_setting == 0`
- `pulse_active == 0`
- `pulse_id == 0`

Metadata is also checked for:

- `passive_capture_mode == true`
- `q_run_mode == "none"`

The result is `PASS`, `CHECK`, or `FAIL`. `roller_actual_current_mA` is not used as evidence of a command because it is raw Roller telemetry.

## Compatibility layers

1. **Opaque preservation**
   - Any selected file can be attached to a Session and stored unchanged in the ZIP.
   - Original filename, byte size, and SHA-256 are retained.

2. **RWLOG01 common-header inspection**
   - When the `RWLOG01` magic and historical common prefix are available, the recorder reads version, run ID, counts, periods, offsets, and CRC location without requiring a version-specific sample decoder.
   - The header size is recorded rather than rejected merely because it is not 110 bytes.

3. **Opportunistic common sample prefix**
   - Project RWLOG versions so far begin each sample with `uint32 time_us` and `uint32 t_test_ms`.
   - When offsets and row size make the prefix safe to read, both timing domains are preserved.
   - Full-log duration from `time_us` is preferred for raw-video duration comparison.
   - `t_test_ms` is kept separately because its zero is an experiment boundary and may occur after a start LED signature.
   - Failure to read this prefix never prevents Session export.

4. **Version decoder registry**
   - `registerRwlogDecoder(version, decoder)` provides optional version-specific decoding/auditing.
   - Future layouts should add decoder modules instead of changing Session, camera, ZIP, or generic pairing code.

## Unknown future versions

An unknown future version (for example v42, v50, or later) remains attachable. The UI reports that a detailed decoder is not installed while common-header, CRC and timing checks continue when structurally available.

If a future format changes the magic or common header layout entirely, the file falls back to opaque preservation and can still be manually paired and exported.

## Pairing policy

RWLOG parsing supplies evidence for pairing; it is not a prerequisite for preserving the file.

The current heuristic uses:

- SHA-256 duplicate detection;
- CRC when available;
- v41 passive safety audit when applicable;
- raw-video duration versus full RWLOG `time_us` duration when available.

Duration comparison is intentionally tolerant of camera lead/trail before or after the device log. LED-anchor synchronization is a later, stronger stage and is not silently replaced by duration matching.

`CHECK` / `MISMATCH` exports require explicit manual override so that uncertainty is recorded in the Session manifest rather than hidden.

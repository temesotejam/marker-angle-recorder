# RWLOG compatibility strategy

The recorder must never become unusable only because firmware introduced a new RWLOG sample layout.

## Compatibility layers

1. **Opaque preservation**
   - Any selected file can be attached to a Session and stored unchanged in the ZIP.
   - Original filename, byte size, and SHA-256 are retained.

2. **RWLOG01 common-header inspection**
   - When the `RWLOG01` magic and the historical common prefix are available, the recorder reads version, run ID, counts, periods, offsets, and CRC location without requiring a version-specific sample decoder.
   - The header size is recorded rather than hard-rejected solely for not being 110 bytes.

3. **Opportunistic common sample prefix**
   - Existing project RWLOG versions begin each sample with `uint32 time_us` and `uint32 t_test_ms`.
   - If offsets and row size make that prefix safe to read, the first/last `t_test_ms` values are used for a duration check.
   - Failure to read this prefix never prevents Session export.

4. **Version decoder registry**
   - `registerRwlogDecoder(version, decoder)` provides optional detailed decoding.
   - A future layout should be added as a decoder module instead of changing Session, camera, ZIP, or pairing code.

## Unknown versions

An unknown future version (for example v36 or v40) remains attachable. The UI reports that a detailed decoder is not installed, while common-header/CRC/time checks continue when structurally available.

If a future format changes the magic or common header layout entirely, the file falls back to opaque preservation and can still be paired manually and exported.

## Pairing policy

RWLOG parsing is evidence for pairing, not a requirement for preservation. Duration and CRC checks are advisory. `CHECK`/`MISMATCH` exports require an explicit manual override so that uncertainty is recorded in the manifest rather than silently ignored.

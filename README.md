# Marker Angle Recorder

Browser-based marker angle measurement and experiment Session recorder for research measurements.

## Version 1 goal

Treat one experiment as one immutable Session:

```text
Camera -> raw video
       -> marker detection -> angle CSV
RWLOG  -> compatibility / CRC / passive audit / duration checks
                                  |
                                  v
                         Session manifest
                                  |
                                  v
                             one ZIP
```

The main purpose is to prevent video/RWLOG mix-ups while providing an independent camera-based physical-roll reference.

## Research angle policy

The default mode is **Absolute · fixed horizontal**.

```text
camera_line = -atan2(y2-y1, x2-x1)
absolute_angle = sign * wrapped(camera_line - fixed_horizontal_reference)
```

The fixed-horizontal reference is an installation/calibration value and is persisted in the browser. It is **not** recalculated from the body pose for every run.

For passive research measurements, per-run zero subtraction is prohibited. The optional `Relative ZERO · diagnostic only` mode is kept only for visual/diagnostic use and is explicitly recorded as relative in both CSV and manifest.

See [`docs/ANGLE_REFERENCE.md`](docs/ANGLE_REFERENCE.md).

## Measurement workflow

1. Open the GitHub Pages app over HTTPS.
2. Start the USB camera.
3. Select the marker mode (`Red + Blue` or `White pair`).
4. Keep `Absolute · fixed horizontal` for research acquisition.
5. Confirm the persistent fixed-horizontal offset for the camera installation. `0.000 deg` means the image x-axis is the fixed horizontal reference.
6. Tilt the body in the known positive direction. Use **Invert sign** if necessary, then press **Confirm sign**.
7. Press **REC**, run the experiment, then press **STOP**.
8. Drop the RWLOG produced by that run onto the page.
9. Review SHA-256, CRC, RWLOG version/contract, passive-command audit, duration, duplicate-hash and pair status.
10. Export the Session ZIP.

A recorded Session cannot be replaced with a new Session until it has been exported. `CHECK` / `MISMATCH` can be exported only after an explicit manual override. A missing RWLOG can be saved only with the emergency-export checkbox.

## ZIP layout

```text
<session-id>.zip
├── <session-id>_video_raw.webm
├── <session-id>_angle.csv
├── <session-id>_log.rwlog
└── <session-id>_manifest.json
```

The raw video contains the original camera stream; marker overlays are intentionally not burned into it so that the video can be reprocessed later.

The angle CSV records the camera marker-line angle, fixed horizontal reference, absolute angle, optional relative angle, raw active angle, display-filtered angle, marker coordinates, marker distance, validity, Session time and frame media time.

## RWLOG v41 current contract

The current passive V62-derived logger uses RWLOG file format **v41**:

- magic `RWLOG01`
- little-endian
- 110-byte header
- UTF-8 JSON metadata
- 146-byte fixed-length samples
- 20 ms logging period / 5 ms IMU update period
- trailing CRC32 covering header + metadata + samples

For v41 passive captures, the browser additionally audits the stable packed command prefix across all samples:

- `motor_cmd_mA == 0`
- `current_mA_setting == 0`
- `pulse_active == 0`
- `pulse_id == 0`

and metadata:

- `passive_capture_mode == true`
- `q_run_mode == "none"`

`roller_actual_current_mA` is deliberately not used as proof of a non-zero command because it is raw Roller telemetry.

## RWLOG forward compatibility

RWLOG compatibility is layered so future format changes do **not** make the recorder unusable:

1. any selected log file can be preserved unchanged in the Session ZIP;
2. `RWLOG01` common-header fields are read when structurally available;
3. the shared sample prefix `time_us, t_test_ms` is read opportunistically for timing evidence;
4. known formats may install a version-specific decoder/auditor;
5. an unknown future version remains attachable even when detailed decoding is unavailable.

Raw video pairing prefers full-log duration derived from `time_us`. `t_test_ms` is retained separately as experiment time because its zero is defined after the start LED signature.

See [`docs/RWLOG_COMPATIBILITY.md`](docs/RWLOG_COMPATIBILITY.md).

## Local-only processing

Camera frames, video, marker measurements, RWLOG inspection and ZIP construction run in the browser. Measurement files are not uploaded by the app. ZIP generation is also local and does not depend on a third-party ZIP service.

## Browser notes

A Chromium-based desktop browser is recommended for USB-camera selection and MediaRecorder support. GitHub Pages provides the HTTPS secure context required by the camera API.

## Development

The app is intentionally build-free: static HTML/CSS plus ES modules. GitHub Actions validates JavaScript syntax and deploys the repository root to GitHub Pages after changes reach `main`.

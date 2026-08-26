# Marker Angle Recorder

Browser-based marker angle measurement and experiment Session recorder for research measurements.

## Version 1 goal

Treat one experiment as one immutable Session:

```text
Camera -> raw video
       -> marker detection -> angle CSV
RWLOG  -> compatibility / CRC / duration checks
                         |
                         v
                Session manifest
                         |
                         v
                    one ZIP
```

The main purpose is to prevent video/RWLOG mix-ups while also providing an independent camera-based body-angle reference.

## Measurement workflow

1. Open the GitHub Pages app over HTTPS.
2. Start the USB camera.
3. Select the marker mode (`Red + Blue` or `White pair`).
4. Place the body at physical 0 deg and press **ZERO**.
5. Tilt the body in the known positive direction. Use **Invert sign** if necessary, then press **Confirm sign**.
6. Press **REC**, run the experiment, then press **STOP**.
7. Drop the RWLOG produced by that run onto the page.
8. Review CRC, duration, duplicate-hash and pair status.
9. Export the Session ZIP.

`CHECK` / `MISMATCH` can be exported only after an explicit manual override. A missing RWLOG can be saved only with the emergency-export checkbox.

## ZIP layout

```text
<session-id>.zip
├── <session-id>_video_raw.webm
├── <session-id>_angle.csv
├── <session-id>_log.rwlog
└── <session-id>_manifest.json
```

The raw video contains the original camera stream; marker overlays are intentionally not burned into it. The CSV records both raw zeroed angle and display-filtered angle.

## Angle definition

For marker centers `P1=(x1,y1)` and `P2=(x2,y2)` in image coordinates:

```text
camera_angle = -atan2(y2-y1, x2-x1)
body_angle   = sign * wrapped(camera_angle - zero_angle)
```

The displayed filtered angle uses a light exponential smoothing only for visibility. `angle_raw_deg` remains available in the CSV for analysis.

## RWLOG compatibility

RWLOG compatibility is intentionally layered. Unknown future versions do **not** block Session creation or ZIP export.

- Any file can be preserved unchanged as an opaque attachment.
- `RWLOG01` common-header fields are inspected without requiring a detailed sample decoder.
- CRC and first/last `t_test_ms` are used when structurally safe.
- Version-specific decoding is optional and extensible through a decoder registry.

See [`docs/RWLOG_COMPATIBILITY.md`](docs/RWLOG_COMPATIBILITY.md).

## Local-only processing

Camera frames, video, marker measurements, RWLOG inspection and ZIP construction run in the browser. The measurement files are not uploaded by the app.

## Browser notes

A Chromium-based desktop browser is recommended for USB-camera selection and MediaRecorder support. GitHub Pages provides the HTTPS secure context required by the camera API.

## Development

The app is intentionally build-free: static HTML/CSS plus ES modules. GitHub Actions deploys the repository root to GitHub Pages after changes reach `main`.

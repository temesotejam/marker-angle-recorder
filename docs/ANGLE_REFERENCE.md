# Angle reference policy

## Research default: absolute fixed-horizontal angle

The research mode is **Absolute · fixed horizontal**.

For detected body marker centers `P1=(x1,y1)` and `P2=(x2,y2)` in image coordinates, the camera line is

```text
camera_line_deg = -atan2(y2-y1, x2-x1)
```

and the physical-roll output is

```text
absolute_angle_deg = sign * wrap(camera_line_deg - fixed_horizontal_reference_deg)
```

where `wrap()` maps the difference to approximately `[-180, 180)`.

## Fixed horizontal reference

`fixed_horizontal_reference_deg` belongs to the camera installation / fixed horizon definition. It is persisted independently of the Session and is not inferred from the body's pose at the start of each run.

- `0.000 deg` means the image x-axis itself is the fixed horizontal reference.
- If the camera installation has a known fixed angular offset, store that offset once and reuse it.
- Changing the fixed reference requires sign confirmation again.
- The value used during recording is frozen into the Session manifest and every CSV row.

This preserves the passive-measurement contract: **no per-run zero subtraction**.

## Sign

The sign is explicitly confirmed before REC. The operator tilts the body in the physically defined positive-roll direction and checks the displayed sign.

If it is reversed, use `Invert sign`, then `Confirm sign`.

The chosen multiplier is recorded in the manifest.

## Relative ZERO mode

`Relative ZERO · diagnostic only` exists for visual checks that benefit from a local reference. In that mode:

```text
relative_angle_deg = sign * wrap(camera_line_deg - relative_zero_camera_deg)
```

The UI, CSV and manifest explicitly identify this mode. Relative-zero output must not be substituted for the fixed-horizontal absolute video angle in passive research analysis.

## Display filtering

The large on-screen value uses light exponential smoothing for readability. The CSV always keeps the unfiltered active angle (`angle_raw_deg`) as well as `angle_filtered_deg`.

For absolute mode, `angle_raw_deg` equals `angle_absolute_deg`.

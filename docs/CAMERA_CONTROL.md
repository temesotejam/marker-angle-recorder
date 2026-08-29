# Camera exposure / white-balance control

## Purpose

The marker detector uses fixed white-pixel thresholds. If the camera changes exposure while the operator moves into the frame, the same physical white markers can become darker and cross the threshold. The debug page therefore exposes only the camera controls that the browser and camera driver report through `MediaStreamTrack.getCapabilities()`.

## Workflow

1. Open `debug.html` and start the same camera used for the experiment.
2. Watch the live camera settings. If `exposureTime` changes when the operator enters the image, auto exposure is active and changing the image source.
3. If manual exposure is supported, position the scene at a good brightness and press **今の明るさで露出を固定**.
4. Verify that the image remains usable while the operator moves around the apparatus.
5. Press **このカメラ設定を本番へ保存**.
6. Reload the main page. The saved profile is applied when that camera starts.

## Stored controls

The profile may contain only controls that the browser exposes for the camera:

- `exposureMode`
- `exposureTime`
- `iso`
- `exposureCompensation`
- `whiteBalanceMode`
- `colorTemperature`
- `brightness`

Unsupported controls are not fabricated. A laptop camera can expose none, some, or all of these depending on the camera, Windows driver and browser.

The profile is stored in same-origin `localStorage` under:

`marker-angle-recorder-camera-control-v1`

The saved profile includes the camera label. If the main page is started with a different labeled camera, the saved profile is not applied.

## Exposure-time unit

The MediaStream Image Capture specification defines `exposureTime` in units of 100 microseconds. The debug page shows both the browser value and a human-readable time.

## Research invariant

Camera-source stabilization is separate from marker recognition. This feature does not change:

- white threshold values,
- candidate area/shape limits,
- 96×90 tracking ROIs,
- 1.8× expanded tracking ROI,
- pair selection,
- angle calculation.

If manual exposure is unavailable, the debug page reports that fact and offers only other controls that the browser exposes, such as exposure compensation or brightness.

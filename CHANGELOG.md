# Changelog

## Unreleased

- Units setting: metric or statute. The device's own fields show mi, mph, ft and °F (radar views in yards),
  and `System.getDeviceSettings()` reports `UNIT_STATUTE` to the apps. The side panel's ride data follows it.
- 12-hour clock setting: Time of Day shows 3:53 (no AM/PM, as on the Edge) and `is24Hour` is false.

## 0.1.0 (2026-11-13)

First version.

- Replays a `.fit` ride through a Connect IQ data field's own Monkey C code (`DataField`,
  `SimpleDataField`), with the device screen, the ride on a map and a timeline to scrub.
- Setups (`*.mvlsim.json`): a device, a data screen layout and per field a Connect IQ field or one of
  the device's own fields; several apps on one screen, each running on its own.
- Device data from the SDK's own device files; bitmap fonts, TTF fonts, and measured stand-ins for
  the `.cft` fonts of the Edge models.
- Inputs from the FIT file: sensors, position, timer and laps, gears, radar, weather, user profile and
  zones, battery level.
- Compile check with the real `monkeyc -l 3`; FIT developer fields and `System.println` output in the
  side panel.
- Samples: a made-up ride (`samples/sample-ride.fit`), an example data field (`samples/example-field`) and
  a setup that shows it (`samples/example.mvlsim.json`).

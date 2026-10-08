# Android project tweaks

Applied in `android/` (in-tree). Re-check after major `cap` upgrades.

## Landscape

Main activity: `android:screenOrientation="sensorLandscape"`.

## Deep link (`motl://auth`)

Intent filter on the main activity:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="motl" android:host="auth" />
</intent-filter>
```

## Cleartext (debug only)

For local `http://192.168.x.x:3000` servers, enable cleartext in debug `network_security_config` or `android:usesCleartextTraffic="true"` on debug builds only.

## Immersive / status bar

Use `@capacitor/status-bar` from the app shell; CSS `viewport-fit=cover` is already on play pages.

# Getting Chromium WebXR Running on Meta Quest

This document captures all the steps required to build, install, and test Chromium with WebXR support on Meta Quest 3.

## Prerequisites

- Meta Quest 3 connected via USB with ADB enabled
- Chromium source checked out at `/home/myers/p/chromium-workspace/chromium/src`
- Build target configured for Android ARM64 with OpenXR enabled (`out/Quest`)

## 1. Code Changes for Quest WebXR Support

### Branch: `quest-webxr-support`

The core problem: Quest uses `XR_FB_*` extensions (Meta's vendor extensions), but Chromium's Android OpenXR code requests `XR_ANDROID_*` extensions (Google's Android XR platform). This triggers signature-protected permission requests that fail on non-Meta-signed apps.

#### 1.1 Detect Quest Devices

**File:** `device/vr/public/java/src/org/chromium/device/vr/XrFeatureStatus.java`

```java
public static boolean isXrDevice() {
    // Check for Android XR system feature (Samsung, etc.)
    if (PackageManagerUtils.hasSystemFeature(PackageManagerUtils.XR_OPENXR_FEATURE_NAME)) {
        return true;
    }

    // Check for Meta Quest devices (Quest 2, Quest 3, Quest Pro)
    String manufacturer = Build.MANUFACTURER.toLowerCase(java.util.Locale.US);
    String model = Build.MODEL.toLowerCase(java.util.Locale.US);

    if (manufacturer.equals("oculus") || manufacturer.equals("meta")) {
        if (model.contains("quest")) {
            return true;
        }
    }

    return false;
}
```

#### 1.2 Disable Android XR Extension Handlers

**File:** `device/vr/openxr/openxr_extension_handler_factories.cc`

Changed `#if BUILDFLAG(IS_ANDROID)` to `#if 0 && BUILDFLAG(IS_ANDROID)` to disable:
- `OpenXrUnboundedSpaceProviderAndroidFactory`
- `OpenXrSceneUnderstandingManagerAndroidFactory`

These handlers request `XR_ANDROID_*` extensions that Quest doesn't support.

#### 1.3 Skip Cardboard When OpenXR Available

**File:** `chrome/browser/vr/chrome_xr_integration_client.cc`

```cpp
// Skip Cardboard if OpenXR is enabled (e.g., on Quest or Android XR devices)
if (!device::features::IsOpenXrEnabled() &&
    !IsOtherRuntimeForced(base::CommandLine::ForCurrentProcess(),
                          switches::kWebXrRuntimeCardboard)) {
```

#### 1.4 Remove Signature-Protected Permissions

**File:** `chrome/android/java/AndroidManifest.xml`

Commented out:
```xml
<!-- Removed for Quest compatibility - these are signature-protected on Meta devices
<uses-permission-sdk-23 android:name="android.permission.SCENE_UNDERSTANDING_FINE" />
<uses-permission-sdk-23 android:name="android.permission.HAND_TRACKING" />
-->
```

### 1.5 Hand Tracking Manifest Entries (for controller-less launch)

**File:** `chrome/android/java/AndroidManifest.xml`

Added near line 147:
```xml
<!-- Meta Quest: Enable hand tracking and declare controllers not required -->
<uses-feature android:name="oculus.software.handtracking" android:required="false" />
<uses-feature android:name="oculus.software.vr.app.hybrid" android:required="false" />
<uses-feature android:name="android.hardware.vr.controller" android:required="false" />
<uses-permission android:name="com.oculus.permission.HAND_TRACKING" />
```

Added inside `<application>` tag:
```xml
<!-- Meta Quest: Enable hand tracking so app can launch without controllers -->
<meta-data android:name="com.oculus.handtracking.frequency" android:value="HIGH" />
<meta-data android:name="com.oculus.handtracking.version" android:value="v2.0" />
```

## 2. Building the APK

```bash
cd /home/myers/p/chromium-workspace/chromium/src
export PATH="/home/myers/p/chromium-workspace/depot_tools:$PATH"

# Build the Chrome APK for Quest
autoninja -C out/Quest chrome_public_apk
```

Build output: `out/Quest/apks/ChromePublic.apk`

## 3. Installing on Quest

```bash
# Install the APK (use -r to replace existing)
adb install -r out/Quest/apks/ChromePublic.apk
```

## 4. Bypassing Quest System Dialogs

Quest has several system dialogs that block sideloaded apps. These can be bypassed using Meta's Scriptable Testing Services.

### 4.1 Prerequisites

1. Quest must be connected to WiFi (required for PIN verification)
2. You need your Meta Store PIN

### 4.2 Connect Quest to WiFi via ADB

```bash
adb shell cmd wifi connect-network "SSID" wpa2 "PASSWORD"
```

### 4.3 Disable System Dialogs

```bash
# Disable the "Switch to Controllers" dialog
adb shell content call --uri content://com.oculus.rc --method SET_PROPERTY \
  --extra 'disable_dialogs:b:true' --extra 'PIN:s:YOUR_PIN'

# Disable Guardian boundary system
adb shell content call --uri content://com.oculus.rc --method SET_PROPERTY \
  --extra 'disable_guardian:b:true' --extra 'PIN:s:YOUR_PIN'
```

### 4.4 Re-enable Dialogs (when done testing)

```bash
adb shell content call --uri content://com.oculus.rc --method SET_PROPERTY \
  --extra 'disable_dialogs:b:false' --extra 'PIN:s:YOUR_PIN'

adb shell content call --uri content://com.oculus.rc --method SET_PROPERTY \
  --extra 'disable_guardian:b:false' --extra 'PIN:s:YOUR_PIN'
```

## 5. Bypassing Chrome First-Run Experience

Chrome's first-run experience blocks automated testing. Bypass it by setting preferences:

```bash
# Stop Chrome first
adb shell am force-stop org.chromium.chrome

# Add first_run_flow preference
adb shell "run-as org.chromium.chrome sh -c \"sed -i 's|</map>|    <boolean name=\\\"first_run_flow\\\" value=\\\"true\\\" />\\n</map>|' /data/data/org.chromium.chrome/shared_prefs/org.chromium.chrome_preferences.xml\""

# Add other FRE bypass preferences
adb shell "run-as org.chromium.chrome sh -c \"sed -i 's|</map>|    <boolean name=\\\"lightweight_first_run_flow\\\" value=\\\"true\\\" />\\n    <boolean name=\\\"skip_welcome_page\\\" value=\\\"true\\\" />\\n</map>|' /data/data/org.chromium.chrome/shared_prefs/org.chromium.chrome_preferences.xml\""
```

## 6. Granting VR Permission

To avoid the VR permission prompt, pre-grant it in Chrome's profile preferences:

```bash
# Stop Chrome
adb shell am force-stop org.chromium.chrome

# Pull preferences, modify, and push back
adb shell "run-as org.chromium.chrome cat /data/data/org.chromium.chrome/app_chrome/Default/Preferences" > /tmp/prefs.json

# Use Python to add VR permission
python3 << 'EOF'
import json
with open('/tmp/prefs.json', 'r') as f:
    data = json.load(f)
data['profile']['content_settings']['exceptions']['vr'] = {
    "https://immersive-web.github.io:443,*": {
        "last_modified": "13412974804726233",
        "setting": 1
    }
}
with open('/tmp/prefs_modified.json', 'w') as f:
    json.dump(data, f, separators=(',', ':'))
EOF

# Push back to device
cat /tmp/prefs_modified.json | adb shell "run-as org.chromium.chrome sh -c 'cat > /data/data/org.chromium.chrome/app_chrome/Default/Preferences'"
```

## 7. Launching Chrome and Testing WebXR

### 7.1 Launch Chrome with a URL

```bash
adb shell am start -n org.chromium.chrome/com.google.android.apps.chrome.Main \
  -d "https://immersive-web.github.io/webxr-samples/immersive-vr-session.html"
```

### 7.2 Take Screenshots

```bash
adb shell screencap -p /sdcard/screen.png
adb pull /sdcard/screen.png ./quest_screenshot.png
```

### 7.3 Using CDP (Chrome DevTools Protocol)

```bash
# Set up port forwarding
adb forward tcp:9222 localabstract:chrome_devtools_remote

# List tabs
cdp-cli --cdp-url="http://localhost:9222" tabs

# Click a button with user gesture (required for WebXR)
cdp-cli --cdp-url="http://localhost:9222" click 0 "button" --user-gesture

# Check console for errors
cdp-cli --cdp-url="http://localhost:9222" console 0
```

### 7.4 Capture Logcat for XR Messages

```bash
# Clear and capture XR-related logs
adb logcat -c
adb logcat | grep -i -E "xr|webxr|openxr|chromium"
```

## 8. Current Status

### Working
- Chrome launches on Quest
- Quest device is detected as XR device
- OpenXR instance creation succeeds
- VR permission can be granted
- WebXR test page loads
- ENTER VR button can be clicked with user gesture

### Not Working Yet
- **VR session creation fails** with error: "The specified session configuration is not supported"
- OpenXR instance is created but immediately destroyed without creating a session

### Logs Show
```
OpenXR: xrCreateInstance [start/end] - succeeds
VrRuntimeCompatHelper: DevicesSupported : 1 devices, quest
OpenXR: xrEnumerateEnvironmentBlendModes - called
OpenXR: xrDestroyInstance - called immediately (no session created)
```

## 9. Next Steps to Investigate

1. Check why session creation fails after instance creation
2. Investigate if additional Quest-specific extensions need to be enabled
3. Check graphics binding initialization (OpenGL ES on Android)
4. Look at `NO_RUNTIME_FOUND` error path in `xr_system.cc`

## 10. Useful Commands Reference

```bash
# Check if Quest is connected
adb devices

# Get Quest model info
adb shell getprop ro.product.model
adb shell getprop ro.product.manufacturer

# List installed packages
adb shell pm list packages | grep chrom

# Check Chrome version
adb shell dumpsys package org.chromium.chrome | grep versionName

# Force stop Chrome
adb shell am force-stop org.chromium.chrome

# Clear Chrome data
adb shell pm clear org.chromium.chrome

# View Quest UI hierarchy
adb shell uiautomator dump /sdcard/ui.xml
adb pull /sdcard/ui.xml
```

## References

- [Meta Scriptable Testing Services](https://developers.meta.com/horizon/documentation/unity/ts-scriptable-testing/)
- [WebXR Samples](https://immersive-web.github.io/webxr-samples/)
- [Chromium WebXR Code](https://source.chromium.org/chromium/chromium/src/+/main:device/vr/)

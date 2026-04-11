---
title: MQDH Feature Flags
layout: default
---

# MQDH Feature Flags (Gatekeepers)

Known feature flags used by Meta Quest Developer Hub for Cast 2.0 configuration.

## Magic Island / Casting

| Flag | Description |
|------|-------------|
| `mqdh_xplat_magic_island_feature_wireless_casting_2` | Wireless casting support |
| `mqdh_xplat_magic_island_feature_input_forwarding_2` | Input forwarding (mouse/keyboard/cursor) |
| `mqdh_xplat_magic_island_feature_gaze_click` | Gaze-based click via VirtualCamera pose |
| `mqdh_xplat_magic_island_text_forwarding` | Text input forwarding |
| `mqdh_xplat_magic_island_mic_audio` | Microphone audio |
| `mqdh_xplat_magic_island_force_reapply_fov` | Force reapply FOV |
| `mqdh_xplat_magic_island_system_monitor` | System monitor overlay |
| `mqdh_xplat_magic_island_panel_streaming` | Panel app streaming |
| `mqdh_xplat_magic_island_feature_casting_tour` | Casting onboarding tour |
| `xplat_magic_island_image_stabilization` | Image stabilization |

## Metacam / Screen Capture

| Flag | Description |
|------|-------------|
| `mqdh_metacam_screen_capture_v63` | Screen capture (OS v63+) |
| `mqdh_metacam_video_capture` | Video capture |

## Input Forwarding (legacy)

| Flag | Description |
|------|-------------|
| `mqdh_input_forwarding_feature` | Legacy input forwarding feature flag |

## Link

| Flag | Description |
|------|-------------|
| `mqdh_link_terminate_via_qlh` | Terminate Link via Quest Link Hub |
| `mqdh_link_dogfood_hub` | Link dogfood hub |

## Device Management

| Flag | Description |
|------|-------------|
| `mqdh_auto_disable_proximity_sensor` | Auto-disable prox sensor |
| `mqdh_disable_proximity_sensor_with_duration` | Timed prox sensor disable |
| `mqdh_collect_hmd_logs` | Collect headset logs |
| `mqdh_redesign_device_manager` | Redesigned device manager UI |
| `mqdh_quick_ble_connect_v2` | Quick BLE connect v2 |
| `mqdh_ble_security_fixes` | BLE security fixes |
| `mqdh_ignore_ble_already_connected` | Ignore BLE already connected state |
| `mqdh_release_channel` | Release channel support |
| `mqdh_release_channel_selector` | Release channel selector UI |
| `mqdh_system_apk` | System APK management |
| `mqdh_device_setup_ab_test` | Device setup A/B test |

## App / UI

| Flag | Description |
|------|-------------|
| `mqdh_redesign_home` | Redesigned home screen |
| `mqdh_redesign_settings` | Redesigned settings |
| `mqdh_logcat_redesign` | Redesigned logcat viewer |
| `mqdh_development_view` | Development view |
| `mqdh_enable_link_card` | Link card UI |
| `mqdh_enable_expanded_link_card` | Expanded link card UI |
| `mqdh_file_mananger_sync` | File manager sync (typo in original) |
| `mqdh_live_build_test_status` | Live build test status |
| `mqdh_in_app_sentiment_survey` | In-app sentiment survey |
| `mqdh_ai_companion` | AI companion feature |
| `mqdh_xr_projects_flythrough` | XR projects flythrough |
| `mqdh_enable_3p_network_impairment_tool` | Network impairment tool |
| `mqdh_audience_attestation_selection` | Audience attestation |

## Auto-Update

| Flag | Description |
|------|-------------|
| `mqdh_force_update_enabled_v2` | Force update enabled |
| `mqdh_force_update_internal_user` | Internal user update |
| `mqdh_force_update_safe_listed_user` | Safe-listed user |
| `mqdh_autoupdate_modal_workflow_public_v3` | Auto-update modal v3 |
| `mqdh_automated_adb_path_fixing_v2` | Automated ADB path fix |

## Dogfooding

| Flag | Description |
|------|-------------|
| `mqdh_dogfooding_hub` | Dogfooding hub |
| `mqdh_dogfooding_hub_bluetooth` | Dogfooding via BT |
| `mqdh_dogfooding_skip_nux` | Skip NUX for dogfood |

## Telemetry

| Flag | Description |
|------|-------------|
| `mqdh_unified_telemetry_consent_ui` | Telemetry consent UI |
| `mqdh_unified_telemetry_internal_only_test` | Internal telemetry test |

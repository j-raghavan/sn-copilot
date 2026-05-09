package com.sncopilot.overlay

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * CopilotOverlayPackage — registers CopilotOverlayModule with React
 * Native so JS can call NativeModules.CopilotOverlay.{open,move,close}.
 *
 * Discovered automatically by buildPlugin.sh's
 * find_manual_react_packages_from_application parser, which scans
 * MainApplication.kt for `add(CopilotOverlayPackage())` and triggers
 * the gradle native build whenever a custom ReactPackage is found.
 */
class CopilotOverlayPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
      listOf(CopilotOverlayModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
      emptyList()
}

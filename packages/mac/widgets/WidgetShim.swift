// The only Swift Beluga.app itself links: WidgetCenter has no Objective-C API, so it's exposed as C.
// Built into a static library by src-tauri/build.rs; called from src-tauri/src/widgets.rs.
import Foundation
import WidgetKit

@_cdecl("beluga_widgets_reload")
public func beluga_widgets_reload() {
    if #available(macOS 11.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
    }
}

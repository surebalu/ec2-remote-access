import UIKit

enum Device {
    /// "iPad" or "iPhone", for text that names the device the app is running on.
    @MainActor static var name: String { UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone" }
}

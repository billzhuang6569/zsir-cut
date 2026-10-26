import AppKit
import CoreText
import Foundation

let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let fontURL = URL(fileURLWithPath: "/System/Library/Fonts/Hiragino Sans GB.ttc")
CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
guard let font = NSFont(name: "HiraginoSansGB-W3", size: 36) else {
    fatalError("Hiragino Sans GB font unavailable")
}
let labels = try JSONSerialization.jsonObject(with: Data(contentsOf: input)) as! [[String: Any]]
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
for label in labels {
    let name = label["name"] as! String
    let text = label["text"] as! String
    let width = label["width"] as! Int
    let height = label["height"] as! Int
    let size = label["size"] as! CGFloat
    let pixels = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height * 4)
    pixels.initialize(repeating: 0, count: width * height * 4)
    defer { pixels.deallocate() }
    guard let context = CGContext(data: pixels, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("CGContext failed") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    let attributes: [NSAttributedString.Key: Any] = [.font: font.withSize(size), .foregroundColor: NSColor.white]
    let measured = (text as NSString).size(withAttributes: attributes)
    let x = (label["center"] as? Bool) == true ? max(0, (CGFloat(width) - measured.width) / 2) : 2
    (text as NSString).draw(at: NSPoint(x: x, y: CGFloat(height - Int(size) - 8)), withAttributes: attributes)
    NSGraphicsContext.restoreGraphicsState()
    try Data(bytes: pixels, count: width * height * 4).write(to: output.appendingPathComponent(name + ".rgba"))
}

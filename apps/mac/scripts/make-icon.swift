// Draws the 1024 px app icon: a gradient squircle with a relay glyph, two agents
// handing a message across an arc, with an approval check on the hand-off.
//   swift scripts/make-icon.swift out.png
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                           samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                           bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.current = ctx
ctx.shouldAntialias = true
let cg = ctx.cgContext

func rgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

/// Continuous-corner squircle (superellipse, n = 5) like the macOS icon shape.
func squircle(_ r: NSRect) -> NSBezierPath {
    let p = NSBezierPath()
    let n = 5.0, steps = 720
    let a = r.width / 2, b = r.height / 2, cx = r.midX, cy = r.midY
    for i in 0...steps {
        let t = Double(i) / Double(steps) * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = cx + a * CGFloat(copysign(pow(abs(c), 2 / n), c))
        let y = cy + b * CGFloat(copysign(pow(abs(s), 2 / n), s))
        i == 0 ? p.move(to: NSPoint(x: x, y: y)) : p.line(to: NSPoint(x: x, y: y))
    }
    p.close()
    return p
}

// macOS grid: 824 px body centered in 1024, soft drop shadow below.
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = squircle(body)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
shadow.shadowBlurRadius = 28
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.set()
rgb(40, 60, 200).setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

// Background: indigo to teal, diagonal.
NSGraphicsContext.saveGraphicsState()
shape.addClip()
NSGradient(colors: [rgb(88, 86, 214), rgb(52, 120, 246), rgb(48, 196, 214)],
           atLocations: [0, 0.55, 1], colorSpace: .sRGB)!.draw(in: body, angle: -55)
// Top sheen.
NSGradient(starting: NSColor.white.withAlphaComponent(0.22), ending: NSColor.white.withAlphaComponent(0))!
    .draw(in: NSRect(x: 100, y: 520, width: 824, height: 404), angle: -90)
NSGraphicsContext.restoreGraphicsState()

// Glyph geometry.
let left = NSPoint(x: 300, y: 400)
let right = NSPoint(x: 724, y: 400)
let nodeR: CGFloat = 92

func arc(from a: NSPoint, to b: NSPoint, lift: CGFloat) -> NSBezierPath {
    let p = NSBezierPath()
    p.move(to: a)
    p.curve(to: b, controlPoint1: NSPoint(x: a.x + 40, y: a.y + lift), controlPoint2: NSPoint(x: b.x - 40, y: b.y + lift))
    return p
}

// Back arc (the reply), translucent, under the nodes.
let back = arc(from: NSPoint(x: right.x - 30, y: right.y - nodeR + 10), to: NSPoint(x: left.x + 30, y: left.y - nodeR + 10), lift: -150)
back.lineWidth = 30
back.lineCapStyle = .round
NSColor.white.withAlphaComponent(0.35).setStroke()
back.stroke()

// Front arc (the hand-off), bold white, ending in an arrow head on the right node.
let start = NSPoint(x: left.x + 18, y: left.y + nodeR - 6)
let tip = NSPoint(x: right.x - 18, y: right.y + nodeR + 14)
let c1 = NSPoint(x: start.x + 20, y: start.y + 330)
let c2 = NSPoint(x: tip.x - 20, y: tip.y + 330)
// Direction of travel at the tip, from the last control point.
let dx = tip.x - c2.x, dy = tip.y - c2.y
let len = (dx * dx + dy * dy).squareRoot()
let ux = dx / len, uy = dy / len
let headLen: CGFloat = 110, headHalf: CGFloat = 78
let base = NSPoint(x: tip.x - ux * headLen, y: tip.y - uy * headLen)
let front = NSBezierPath()
front.move(to: start)
front.curve(to: NSPoint(x: base.x + ux * 10, y: base.y + uy * 10), controlPoint1: c1, controlPoint2: c2)
front.lineWidth = 48
front.lineCapStyle = .round
NSGraphicsContext.saveGraphicsState()
let glow = NSShadow()
glow.shadowColor = NSColor.black.withAlphaComponent(0.18)
glow.shadowBlurRadius = 18
glow.shadowOffset = NSSize(width: 0, height: -6)
glow.set()
// One transparency layer so the shadow falls once, under the whole glyph.
cg.beginTransparencyLayer(auxiliaryInfo: nil)
NSColor.white.setStroke()
front.stroke()
let head = NSBezierPath()
head.move(to: tip)
head.line(to: NSPoint(x: base.x - uy * headHalf, y: base.y + ux * headHalf))
head.line(to: NSPoint(x: base.x + uy * headHalf, y: base.y - ux * headHalf))
head.close()
head.lineJoinStyle = .round
head.lineWidth = 16
NSColor.white.setFill()
NSColor.white.setStroke()
head.fill()
head.stroke()

// Nodes: the two agents.
for c in [left, right] {
    let o = NSBezierPath(ovalIn: NSRect(x: c.x - nodeR, y: c.y - nodeR, width: nodeR * 2, height: nodeR * 2))
    NSColor.white.setFill()
    o.fill()
}
cg.endTransparencyLayer()
NSGraphicsContext.restoreGraphicsState()

// Agent faces: two eyes on each node, tinted from the background.
for (c, color) in [(left, rgb(88, 86, 214)), (right, rgb(40, 160, 210))] {
    color.setFill()
    for dx in [-28.0, 28.0] {
        NSBezierPath(roundedRect: NSRect(x: c.x + dx - 14, y: c.y - 28, width: 28, height: 56), xRadius: 14, yRadius: 14).fill()
    }
}

// Approval check on the top of the arc: an orange seal.
let frontEnd = NSPoint(x: base.x + ux * 10, y: base.y + uy * 10)
let seal = NSPoint(x: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * frontEnd.x,
                   y: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * frontEnd.y)
let sealR: CGFloat = 74
NSGraphicsContext.saveGraphicsState()
let s2 = NSShadow()
s2.shadowColor = NSColor.black.withAlphaComponent(0.25)
s2.shadowBlurRadius = 16
s2.shadowOffset = NSSize(width: 0, height: -6)
s2.set()
NSGradient(starting: rgb(255, 184, 64), ending: rgb(255, 140, 30))!
    .draw(in: NSBezierPath(ovalIn: NSRect(x: seal.x - sealR, y: seal.y - sealR, width: sealR * 2, height: sealR * 2)), angle: -90)
NSGraphicsContext.restoreGraphicsState()
let ring = NSBezierPath(ovalIn: NSRect(x: seal.x - sealR, y: seal.y - sealR, width: sealR * 2, height: sealR * 2))
ring.lineWidth = 12
NSColor.white.setStroke()
ring.stroke()
let check = NSBezierPath()
check.move(to: NSPoint(x: seal.x - 32, y: seal.y + 2))
check.line(to: NSPoint(x: seal.x - 8, y: seal.y - 24))
check.line(to: NSPoint(x: seal.x + 34, y: seal.y + 26))
check.lineWidth = 20
check.lineCapStyle = .round
check.lineJoinStyle = .round
NSColor.white.setStroke()
check.stroke()

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")

#!/usr/bin/env bash
# Builds "Agent Relay.app" (universal arm64 + x86_64), ad-hoc signs it and packs
# dist/agent-relay-mac-<version>.zip and .dmg.
set -euo pipefail

VERSION="0.5.0"
APP_NAME="Agent Relay"
BUNDLE_ID="org.antonyuk.agent-relay"
EXEC="AgentRelay"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/$APP_NAME.app"
WORK="$ROOT/.build/package"
cd "$ROOT"

echo "==> building universal release binary"
BIN=""
if swift build -c release --arch arm64 --arch x86_64 --product "$EXEC"; then
  BIN="$(swift build -c release --arch arm64 --arch x86_64 --product "$EXEC" --show-bin-path)/$EXEC"
else
  echo "==> universal build failed, building per arch and joining with lipo"
  swift build -c release --arch arm64 --product "$EXEC"
  swift build -c release --arch x86_64 --product "$EXEC"
  mkdir -p "$WORK"
  lipo -create \
    "$(swift build -c release --arch arm64 --show-bin-path)/$EXEC" \
    "$(swift build -c release --arch x86_64 --show-bin-path)/$EXEC" \
    -output "$WORK/$EXEC"
  BIN="$WORK/$EXEC"
fi
lipo -info "$BIN"

echo "==> app icon"
rm -rf "$WORK/AppIcon.iconset"
mkdir -p "$WORK/AppIcon.iconset"
swift "$ROOT/scripts/make-icon.swift" "$WORK/icon-1024.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon-1024.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$WORK/icon-1024.png" --out "$WORK/AppIcon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$WORK/AppIcon.iconset" -o "$WORK/AppIcon.icns"

echo "==> assembling $APP_NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXEC"
cp "$WORK/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
YEAR="$(date +%Y)"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$EXEC</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><false/>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSHumanReadableCopyright</key><string>Copyright © $YEAR Dmytro Antonyuk</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"

# A stable identity keeps the same designated requirement across builds, so the
# Keychain "Always Allow" for the console token survives updates. Ad-hoc signing
# changes the hash every build and macOS asks for the login password again.
# Override with SIGN_IDENTITY=- (ad-hoc) or any identity name/hash.
IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
IDENTITY="${IDENTITY:--}"
echo "==> signing with: $IDENTITY"
codesign --force --deep --options runtime -s "$IDENTITY" "$APP"
codesign --verify --verbose=1 "$APP"

echo "==> zip"
ZIP="$DIST/agent-relay-mac-$VERSION.zip"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

echo "==> dmg"
DMG="$DIST/agent-relay-mac-$VERSION.dmg"
STAGE="$WORK/dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$APP_NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"

echo "==> done"
ls -lh "$ZIP" "$DMG"

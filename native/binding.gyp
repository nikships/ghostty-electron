{
  "targets": [
    {
      "target_name": "ghostty_producer",
      "sources": ["src/producer.m"],
      "include_dirs": ["../vendor/ghostty/zig-out/include"],
      "libraries": [
        "<(module_root_dir)/../vendor/ghostty/zig-out/lib/libghostty-vt.a",
        "-framework IOSurface",
        "-framework CoreGraphics",
        "-framework CoreText",
        "-framework CoreFoundation"
      ],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_CFLAGS": ["-fobjc-arc"]
      }
    }
  ]
}

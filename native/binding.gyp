{
  "targets": [
    {
      "target_name": "ghostty_producer",
      "sources": ["src/vt.c"],
      "include_dirs": ["../vendor/ghostty/zig-out/include"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/producer_mac.m"],
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
        }],
        ["OS=='win'", {
          "sources": ["src/producer_stub.c"],
          "libraries": [
            "<(module_root_dir)/../vendor/ghostty/zig-out/lib/ghostty-vt.lib",
            "libcmt.lib",
            "libucrt.lib",
            "libvcruntime.lib"
          ]
        }],
        ["OS not in ['mac', 'win']", {
          "sources": ["src/producer_stub.c"],
          "libraries": [
            "<(module_root_dir)/../vendor/ghostty/zig-out/lib/libghostty-vt.a"
          ]
        }]
      ]
    }
  ]
}

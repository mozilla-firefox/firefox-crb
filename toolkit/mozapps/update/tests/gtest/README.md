# Running these tests

The tests in this directory are built into the program `update-gtest`, rather than `xul-gtest`.

To run them, first run `./mach build` and then run the `update-gtext` executable from your obj
directory. For example, on Windows, this would be: `.\obj-x86_64-pc-windows-msvc\dist\bin\update-gtest.exe`

These tests don't run in CI. On macOS, the `CreateAndOpenFile` test checks what the elevated updater does as root, so it only runs as root and is skipped otherwise. To run it, use `sudo`, for example: `sudo ./obj-aarch64-apple-darwin/dist/bin/update-gtest --gtest_filter='CreateAndOpenFile.*'`

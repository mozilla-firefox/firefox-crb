# Running these tests

The tests in this directory are built into the program `update-gtest`, rather than `xul-gtest`.

To run them, first run `./mach build` and then run the `update-gtest` executable from your obj
directory. For example, on Windows, this would be: `.\obj-x86_64-pc-windows-msvc\_tests\xpcshell\toolkit\mozapps\update\tests\data\update-gtest.exe`

On Windows, `postUpdateEnvironment_win.js` in the base updater xpcshell suite runs `PostUpdateEnvironmentTest.*` from this executable. The executable is included in the xpcshell test package.

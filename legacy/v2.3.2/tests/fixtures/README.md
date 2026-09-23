The certificate and private key in this directory are public, disposable fixtures
for the HTTPS integration test. They are not credentials for any real service.

The test binds its HTTPS server to 127.0.0.1 on a random port and maps the fixture
hostname to that server only inside an isolated Chromium process. Certificate
validation is disabled only for that test process. Production extension URL
validation and browser security settings are unchanged.

No test files or certificates are included in the extension ZIP.

storage-extension.test.js loads an isolated copy of dist. It scales only the
Range threshold/chunk size and fixes the advisory storage estimate at 8 MiB.
Real OPFS and IndexedDB APIs remain in use. CDP overrides the extension's actual
quota to 64 MiB and 3 MiB to verify both parallel saving and native fallback
with a 6 MiB synthetic file. Both saved files must match SHA-256 and leave no
temporary files or checkpoints. The production thresholds are unchanged.

neonplayer-mixed.mpd is synthetic and models the public Neonplayer response
layout observed during the v2.3.2 investigation: complete A/V MP4 files can
coexist with muxed segments and optional audio-only tracks. A higher-bitrate
silent video candidate also checks that selection cannot drop the audio.
All URLs, identifiers and tokens in this fixture are dummy test values.

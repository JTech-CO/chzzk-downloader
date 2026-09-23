The certificate and private key in this directory are public, disposable fixtures
for the HTTPS integration test. They are not credentials for any real service.

The test binds its HTTPS server to 127.0.0.1 on a random port and maps the fixture
hostname to that server only inside an isolated Chromium process. Certificate
validation is disabled only for that test process. Production extension URL
validation and browser security settings are unchanged.

No test files or certificates are included in the extension ZIP.

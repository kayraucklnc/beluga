// Videos stream from the link worklet's own server on the phone's loopback (http://127.0.0.1,
// src/companion/media-stream.ts). Android blocks plain http by default, so this lets it through
// for 127.0.0.1 and localhost only (a network security config); everything else stays https-only.
// The bytes inside never leave the phone: the link to the Mac is the Noise stream.
const fs = require('node:fs');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

const XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;
// Debug builds talk to Metro over the LAN in plain http (the manifest's usesCleartextTraffic,
// which a network security config replaces): the debug resources keep that.
const DEBUG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`;

module.exports = function withLoopbackCleartext(config) {
  config = withDangerousMod(config, [
    'android',
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'beluga_network_security.xml'), XML);
      const debug = path.join(c.modRequest.platformProjectRoot, 'app', 'src', 'debug', 'res', 'xml');
      fs.mkdirSync(debug, { recursive: true });
      fs.writeFileSync(path.join(debug, 'beluga_network_security.xml'), DEBUG_XML);
      return c;
    },
  ]);
  return withAndroidManifest(config, (c) => {
    const app = c.modResults.manifest.application?.[0];
    if (app) app.$['android:networkSecurityConfig'] = '@xml/beluga_network_security';
    return c;
  });
};

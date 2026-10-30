// Release builds are signed with Beluga's own key (BLG-430), never the template's public debug
// key: Android installs an update only over an app signed with the same key, and Beluga Link
// trusts the app by it too. scripts/build-apk.mjs reads the key's password from the Keychain
// and passes the key in BELUGA_ANDROID_KEYSTORE / BELUGA_ANDROID_KEY_PASSWORD. Without them a
// release build is signed with the debug key and gradle says so: fine to try on your own phone,
// never to attach to a release.
const { withAppBuildGradle } = require('expo/config-plugins');

const CONFIG = `    signingConfigs {
        if (System.getenv('BELUGA_ANDROID_KEYSTORE')) {
            release {
                storeFile file(System.getenv('BELUGA_ANDROID_KEYSTORE'))
                storePassword System.getenv('BELUGA_ANDROID_KEY_PASSWORD')
                keyAlias System.getenv('BELUGA_ANDROID_KEY_ALIAS') ?: 'beluga'
                keyPassword System.getenv('BELUGA_ANDROID_KEY_PASSWORD')
            }
        } else {
            logger.warn('Beluga: no BELUGA_ANDROID_KEYSTORE, so this release build is signed with the debug key (not for a release)')
        }
        debug {`;

const PICK = "signingConfig System.getenv('BELUGA_ANDROID_KEYSTORE') ? signingConfigs.release : signingConfigs.debug";

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;
    if (g.includes('BELUGA_ANDROID_KEYSTORE')) return c;
    const head = /    signingConfigs \{\n        debug \{/;
    const release = /(release \{\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/;
    if (!head.test(g) || !release.test(g)) throw new Error('release-signing: app/build.gradle no longer looks as expected');
    g = g.replace(head, CONFIG).replace(release, `$1${PICK}`);
    c.modResults.contents = g;
    return c;
  });
};

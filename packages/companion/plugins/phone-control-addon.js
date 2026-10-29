// Beluga Phone Control (BLG-377), the small app with the Accessibility service, is built beside the
// Beluga app: this adds modules/phone-control/addon to the generated android project, so
// `./gradlew assembleRelease` makes both APKs (phone-control-addon/build/outputs/apk/release).
const { withSettingsGradle } = require('expo/config-plugins');

const LINE = "include ':phone-control-addon'\nproject(':phone-control-addon').projectDir = new File(rootDir, '../modules/phone-control/addon')\n";

module.exports = function withPhoneControlAddon(config) {
  return withSettingsGradle(config, (c) => {
    if (!c.modResults.contents.includes(':phone-control-addon')) c.modResults.contents += `\n${LINE}`;
    return c;
  });
};

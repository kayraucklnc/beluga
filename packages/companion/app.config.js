// app.json is the config; this only lets an iOS build name whose Apple team signs it, and its own
// bundle identifier when that team can't register Beluga's (sh.ratel.beluga belongs to one team).
// Neither is in the repo: scripts/build-ios.mjs and README "iOS" pass them in.
//   BELUGA_APPLE_TEAM_ID       the 10-character team ID (developer.apple.com › Membership)
//   BELUGA_IOS_BUNDLE_ID       e.g. com.yourname.beluga (optional)
//   BELUGA_IOS_BUILD_NUMBER    CFBundleVersion; every TestFlight upload needs a new one (the script sets it)
module.exports = ({ config }) => {
  const team = process.env.BELUGA_APPLE_TEAM_ID?.trim();
  const bundle = process.env.BELUGA_IOS_BUNDLE_ID?.trim();
  const build = process.env.BELUGA_IOS_BUILD_NUMBER?.trim();
  if (team && !/^[A-Z0-9]{10}$/.test(team)) throw new Error(`BELUGA_APPLE_TEAM_ID should be 10 letters and digits, not "${team}"`);
  if (bundle && !/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundle)) throw new Error(`BELUGA_IOS_BUNDLE_ID isn't a bundle identifier: "${bundle}"`);
  if (build && !/^\d+(\.\d+){0,2}$/.test(build)) throw new Error(`BELUGA_IOS_BUILD_NUMBER should be digits (up to three parts), not "${build}"`);
  return {
    ...config,
    ios: {
      ...config.ios,
      ...(team ? { appleTeamId: team } : {}),
      ...(bundle ? { bundleIdentifier: bundle } : {}),
      ...(build ? { buildNumber: build } : {}),
    },
  };
};

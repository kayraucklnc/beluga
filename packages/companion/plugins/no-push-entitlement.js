// expo-notifications gives the iOS app the Push Notifications entitlement (aps-environment), but
// the app has no push yet (README "iOS": notifications are local, made while the link is open).
// Without it a free Apple team can sign the app for your own iPhone (personal teams can't have
// Push Notifications). Push, when it comes, takes this plugin out. It is first in app.json's
// plugins on purpose: Expo runs mods last-added first, so the first one runs after the others.
const { withEntitlementsPlist } = require('expo/config-plugins');

module.exports = function withoutPushEntitlement(config) {
  return withEntitlementsPlist(config, (c) => {
    const { 'aps-environment': _, ...rest } = c.modResults;
    c.modResults = rest;
    return c;
  });
};

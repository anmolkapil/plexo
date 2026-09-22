const scenario = JSON.parse(process.env.PAGE_SCENARIO)
const define = (name, value) => Object.defineProperty(navigator, name, { get: () => value })

define('platform', scenario.platform)
define('maxTouchPoints', scenario.maxTouchPoints ?? 0)
// Chromium answers; Safari and Firefox have no userAgentData at all.
define(
  'userAgentData',
  scenario.architecture
    ? { getHighEntropyValues: async () => ({ architecture: scenario.architecture }) }
    : undefined
)

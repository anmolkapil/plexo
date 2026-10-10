// Firefox returns promises only through `browser`: its `chrome` takes callbacks. Chrome has
// `browser` from 148, and promises on `chrome` before that.
export const api: typeof chrome = (globalThis as { browser?: typeof chrome }).browser ?? chrome

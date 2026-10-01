// Only newly created source windows are touched. Native tracking precedes login.
export async function openSourceWindow(chrome, url, intent) {
  const window = await chrome.windows.create({ url: intent?.url ?? url, type: "normal", focused: true });
  const tab = window?.tabs?.[0];
  if (!intent) return tab;
  try {
    if (!Number.isInteger(tab?.id) || !Number.isInteger(window?.id)) throw new Error("Source window is unavailable.");
    await intent.prepare();
  } catch (error) {
    if (Number.isInteger(window?.id)) await chrome.windows.remove(window.id).catch(() => undefined);
    throw error;
  }
  // Once bound, preserve the tracked window even if navigation fails.
  return await chrome.tabs.update(tab.id, { url, active: true });
}

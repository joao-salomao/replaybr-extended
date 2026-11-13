// The toolbar icon opens the app in its own tab.
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});

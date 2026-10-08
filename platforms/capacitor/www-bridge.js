/**
 * Optional Capacitor shell bridge loaded from index if present.
 * Deep links + Browser plugin; landscape/orientation configured in native projects.
 */
(async () => {
  if (!window.Capacitor) return;
  window.MOTL_SHELL = true;
  try {
    const { App } = await import("@capacitor/app");
    const { Browser } = await import("@capacitor/browser");
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    window.Capacitor.Plugins.Browser = Browser;

    App.addListener("appUrlOpen", (event) => {
      try {
        const u = new URL(event.url);
        const token = u.searchParams.get("token");
        if (token) {
          localStorage.setItem("motl.sessionToken", token);
          location.href = "/app/games.html";
        }
      } catch {
        // ignore
      }
    });
  } catch (err) {
    console.warn("Capacitor bridge unavailable", err);
  }
})();

/**
 * Coalesce tooltip / volume preference writes. The in-memory player
 * object is updated by the caller immediately; SQLite follows once.
 */
export function scheduleSettingWrite(socket, key, value, write, delayMs = 1000) {
  if (!socket || !socket.data || typeof write !== "function") return;
  if (!socket.data.settingWrites) socket.data.settingWrites = {};
  const slot = socket.data.settingWrites[key] || (socket.data.settingWrites[key] = {});
  if (slot.persisted === value && !slot.timer) return;
  slot.value = value;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    slot.timer = null;
    if (slot.persisted === slot.value) return;
    const next = slot.value;
    slot.persisted = next;
    Promise.resolve(write(next)).catch((err) => console.error(err));
  }, delayMs);
  if (slot.timer.unref) slot.timer.unref();
}

import assert from "node:assert/strict";
import test from "node:test";
import { scheduleSettingWrite } from "../server/settingsWrite.js";

test("identical setting writes collapse to one database call", async () => {
  const socket = { data: {} };
  let writes = 0;
  const write = () => {
    writes += 1;
  };
  scheduleSettingWrite(socket, "bgmVolume", 40, write, 30);
  scheduleSettingWrite(socket, "bgmVolume", 40, write, 30);
  scheduleSettingWrite(socket, "bgmVolume", 41, write, 30);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes, 1);

  scheduleSettingWrite(socket, "bgmVolume", 41, write, 30);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes, 1);
});

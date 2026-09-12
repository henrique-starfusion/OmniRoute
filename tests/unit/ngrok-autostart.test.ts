import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isNgrokAutoStartEnabled } from "../../src/lib/ngrokAutoStart.ts";

const ORIGINAL_TOKEN = process.env.NGROK_AUTHTOKEN;
const ORIGINAL_FLAG = process.env.OMNIROUTE_NGROK_AUTOSTART;

function setEnv(token: string | undefined, flag: string | undefined): void {
  if (token === undefined) delete process.env.NGROK_AUTHTOKEN;
  else process.env.NGROK_AUTHTOKEN = token;

  if (flag === undefined) delete process.env.OMNIROUTE_NGROK_AUTOSTART;
  else process.env.OMNIROUTE_NGROK_AUTOSTART = flag;
}

afterEach(() => {
  setEnv(ORIGINAL_TOKEN, ORIGINAL_FLAG);
});

describe("ngrok auto-start gate", () => {
  it("stays closed when nothing is configured", () => {
    setEnv(undefined, undefined);
    assert.equal(isNgrokAutoStartEnabled(), false);
  });

  // The whole point of the double opt-in: a token configured for occasional
  // manual use must never publish the instance on a public URL at every boot.
  it("stays closed when only the authtoken is set", () => {
    setEnv("2abcDEF_realLookingToken", undefined);
    assert.equal(isNgrokAutoStartEnabled(), false);
  });

  it("stays closed when only the flag is set", () => {
    setEnv(undefined, "true");
    assert.equal(isNgrokAutoStartEnabled(), false);
  });

  it("treats a blank authtoken as absent", () => {
    for (const blank of ["", "   "]) {
      setEnv(blank, "true");
      assert.equal(isNgrokAutoStartEnabled(), false, `blank token ${JSON.stringify(blank)}`);
    }
  });

  it("rejects falsy flag values", () => {
    for (const flag of ["", "false", "0", "no", "off", "FALSE", "maybe", "2"]) {
      setEnv("2abcDEF_realLookingToken", flag);
      assert.equal(isNgrokAutoStartEnabled(), false, `flag ${JSON.stringify(flag)}`);
    }
  });

  it("opens only with a token plus a truthy flag", () => {
    for (const flag of ["1", "true", "yes", "on", "TRUE", "  True  "]) {
      setEnv("2abcDEF_realLookingToken", flag);
      assert.equal(isNgrokAutoStartEnabled(), true, `flag ${JSON.stringify(flag)}`);
    }
  });
});

// Layer 2 rewrite pinning: the tool shell is not our shell.
//
// `lowfat rewrite` names the binary by bare name, and the host's tool shell need
// not have ~/.local/bin on PATH (a stock macOS tool shell does not). Every
// rewritten search then died with exit 127 before the real command ran.
import test from "node:test";
import assert from "node:assert/strict";

import { hasBareLowfat, pinLowfat, withLowfatOnPath } from "../lib/lowfat.mjs";

const BIN = "/Users/ingobechtle/.local/bin/lowfat";

test("lowfat: the bare command is pinned to the path we resolved", () => {
  assert.equal(pinLowfat("lowfat ls -la", BIN), `${BIN} ls -la`);
  assert.equal(pinLowfat("lowfat git status", BIN), `${BIN} git status`);
});

test("lowfat: a piped rewrite keeps its environment assignment and its pipe", () => {
  assert.equal(
    pinLowfat("LOWFAT_PIPED=1 lowfat grep -rn foo /tmp | head -5", BIN),
    `LOWFAT_PIPED=1 ${BIN} grep -rn foo /tmp | head -5`,
  );
  assert.equal(
    pinLowfat("LOWFAT_PIPED=1 lowfat find . -name '*.ts' | head", BIN),
    `LOWFAT_PIPED=1 ${BIN} find . -name '*.ts' | head`,
  );
});

test("lowfat: command position after an operator counts too", () => {
  assert.equal(pinLowfat("echo hi; lowfat ls -la", BIN), `echo hi; ${BIN} ls -la`);
  assert.equal(pinLowfat("ls | lowfat", BIN), `ls | ${BIN}`);
  assert.equal(pinLowfat("true && lowfat docker ps", BIN), `true && ${BIN} docker ps`);
  assert.equal(pinLowfat("false || lowfat docker ps", BIN), `false || ${BIN} docker ps`);
});

test("lowfat: the word inside an argument is left alone", () => {
  // the exact false positive a naive replace would cause
  assert.equal(pinLowfat("grep -rn lowfat index.js | head", BIN), "grep -rn lowfat index.js | head");
  assert.equal(pinLowfat('grep -rn "lowfat" index.js', BIN), 'grep -rn "lowfat" index.js');
  assert.equal(pinLowfat("cat /Users/me/.local/bin/lowfat.log", BIN), "cat /Users/me/.local/bin/lowfat.log");
});

test("lowfat: an already absolute invocation is untouched", () => {
  const twice = pinLowfat(pinLowfat("lowfat ls", BIN), BIN);
  assert.equal(twice, `${BIN} ls`, "pinning is idempotent");
  assert.equal(pinLowfat(`${BIN} rewrite x`, BIN), `${BIN} rewrite x`);
});

test("lowfat: a path with spaces survives as one shell word", () => {
  assert.equal(pinLowfat("lowfat ls", "/Users/a b/.local/bin/lowfat"), "'/Users/a b/.local/bin/lowfat' ls");
  assert.equal(pinLowfat("lowfat ls", "/Users/o'brien/lowfat"), `'/Users/o'\\''brien/lowfat' ls`);
});

test("lowfat: an unknown rewrite shape gets the directory on PATH instead", () => {
  assert.equal(withLowfatOnPath("env lowfat ls", BIN), 'PATH=/Users/ingobechtle/.local/bin:"$PATH" env lowfat ls');
  assert.equal(withLowfatOnPath("ls | xargs lowfat", BIN), 'PATH=/Users/ingobechtle/.local/bin:"$PATH" ls | xargs lowfat');
  // and a directory that needs quoting gets it
  assert.equal(withLowfatOnPath("env lowfat ls", "/Users/a b/lowfat"), `PATH='/Users/a b':"$PATH" env lowfat ls`);
});

test("lowfat: nothing to pin is not an error", () => {
  for (const value of ["", null, undefined, "cat big.json | jq .", "echo test | head -3"]) {
    assert.equal(pinLowfat(value, BIN), value);
  }
  assert.equal(pinLowfat("lowfat ls", ""), "lowfat ls");
  assert.equal(hasBareLowfat("lowfat ls"), true);
  assert.equal(hasBareLowfat(`${BIN} ls`), false);
  assert.equal(hasBareLowfat("grep -rn lowfat ."), false, "an argument is not an invocation");
});

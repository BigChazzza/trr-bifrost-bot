import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMilestonesToNotify, KILL_MILESTONES } from './killMilestones.js';

test('getMilestonesToNotify returns nothing when no milestone has been crossed', () => {
  assert.deepEqual(getMilestonesToNotify(0, 5), []);
  assert.deepEqual(getMilestonesToNotify(0, 29), []);
  assert.deepEqual(getMilestonesToNotify(30, 35), []);
});

test('getMilestonesToNotify returns the first milestone when player just crosses 30', () => {
  const result = getMilestonesToNotify(0, 30);
  assert.equal(result.length, 1);
  assert.equal(result[0].kills, 30);
});

test('getMilestonesToNotify returns multiple milestones when player jumps across several in one poll', () => {
  const result = getMilestonesToNotify(0, 42);
  assert.equal(result.length, 2);
  assert.equal(result[0].kills, 30);
  assert.equal(result[1].kills, 40);
});

test('getMilestonesToNotify does not re-fire already-notified milestones', () => {
  const result = getMilestonesToNotify(30, 35);
  assert.deepEqual(result, []);
});

test('getMilestonesToNotify fires exactly the next milestone on a clean step-up', () => {
  const result = getMilestonesToNotify(30, 41);
  assert.equal(result.length, 1);
  assert.equal(result[0].kills, 40);
});

test('getMilestonesToNotify fires all 8 milestones when starting from 0 and crossing 100', () => {
  const result = getMilestonesToNotify(0, 100);
  assert.equal(result.length, 8);
  assert.equal(result[0].kills, 30);
  assert.equal(result[result.length - 1].kills, 100);
});

test('getMilestonesToNotify fires nothing when already notified at 100', () => {
  assert.deepEqual(getMilestonesToNotify(100, 120), []);
});

test('all milestone messages include the -BigChazzza Bot signature', () => {
  for (const milestone of KILL_MILESTONES) {
    assert.ok(
      milestone.message.includes('-BigChazzza Bot'),
      `Milestone ${milestone.kills} is missing -BigChazzza Bot signature`
    );
  }
});

test('all milestone messages are unique (no copy-paste duplicates)', () => {
  const messages = KILL_MILESTONES.map((m) => m.message);
  const unique = new Set(messages);
  assert.equal(unique.size, messages.length, 'duplicate milestone messages found');
});

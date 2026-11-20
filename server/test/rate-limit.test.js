import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlidingWindowLimiter } from "../chat/rate-limit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("permite 5 eventos e recusa o 6º com o tempo de espera", () => {
  const time = clock();
  const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 10_000, now: time.now });
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.hit("u").allowed, true);
    time.advance(1_000);
  }
  // Eventos em t=0,1,2,3,4 s; agora t=5 s → o mais antigo sai da janela em t=10 s.
  assert.deepEqual(limiter.hit("u"), { allowed: false, retryAfterMs: 5_000 });
});

test("janela deslizante: libera conforme os eventos antigos expiram", () => {
  const time = clock();
  const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 10_000, now: time.now });
  for (let i = 0; i < 5; i++) limiter.hit("u");
  assert.equal(limiter.hit("u").allowed, false);
  time.advance(10_000);
  assert.equal(limiter.hit("u").allowed, true);
});

test("tentativas recusadas não estendem o bloqueio", () => {
  const time = clock();
  const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1_000, now: time.now });
  limiter.hit("u");
  limiter.hit("u");
  for (let i = 0; i < 50; i++) limiter.hit("u");
  time.advance(1_000);
  assert.equal(limiter.hit("u").allowed, true);
});

test("chaves são independentes", () => {
  const limiter = createSlidingWindowLimiter({ limit: 1, windowMs: 1_000, now: () => 0 });
  assert.equal(limiter.hit("a").allowed, true);
  assert.equal(limiter.hit("a").allowed, false);
  assert.equal(limiter.hit("b").allowed, true);
});

test("sweep remove chaves inativas (sem acúmulo de memória)", () => {
  const time = clock();
  const limiter = createSlidingWindowLimiter({ limit: 5, windowMs: 1_000, now: time.now });
  for (let i = 0; i < 100; i++) limiter.hit(`u${i}`);
  assert.equal(limiter.size(), 100);
  time.advance(1_001);
  limiter.sweep();
  assert.equal(limiter.size(), 0);
});

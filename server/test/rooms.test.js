import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoomRegistry } from "../chat/rooms.js";

/** Timers manuais: `run()` dispara os pendentes. */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    timers: {
      setTimeout: (fn) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clearTimeout: (id) => pending.delete(id),
    },
    count: () => pending.size,
    run() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

const msg = (n) => ({ id: `m${n}`, text: String(n) });

test("join devolve uma cópia do histórico", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "a");
  rooms.append("i-1", msg(1));
  const history = rooms.join("i-1", "b");
  history.push(msg(99));
  assert.deepEqual(rooms.history("i-1"), [msg(1)]);
});

test("histórico circular mantém as 100 mensagens mais recentes", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "a");
  for (let i = 1; i <= 105; i++) rooms.append("i-1", msg(i));
  const history = rooms.history("i-1");
  assert.equal(history.length, 100);
  assert.equal(history[0].id, "m6");
  assert.equal(history.at(-1).id, "m105");
});

test("isolamento: clientes e histórico de cada sala são independentes", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "a");
  rooms.join("i-2", "c");
  rooms.append("i-1", msg(1));
  assert.deepEqual(rooms.clients("i-1"), ["a"]);
  assert.deepEqual(rooms.clients("i-2"), ["c"]);
  assert.deepEqual(rooms.history("i-2"), []);
});

test("append em sala inexistente é ignorado", () => {
  const rooms = createRoomRegistry();
  rooms.append("i-x", msg(1));
  assert.equal(rooms.has("i-x"), false);
});

test("sala vazia é removida após o TTL, com o histórico", () => {
  const t = fakeTimers();
  const rooms = createRoomRegistry({ timers: t.timers });
  rooms.join("i-1", "a");
  rooms.append("i-1", msg(1));
  rooms.leave("i-1", "a");
  assert.equal(rooms.has("i-1"), true, "ainda existe durante o TTL");
  assert.equal(t.count(), 1);
  t.run();
  assert.equal(rooms.has("i-1"), false);
  assert.deepEqual(rooms.join("i-1", "b"), [], "sala nova, sem histórico antigo");
});

test("entrar antes do TTL cancela a remoção e preserva o histórico", () => {
  const t = fakeTimers();
  const rooms = createRoomRegistry({ timers: t.timers });
  rooms.join("i-1", "a");
  rooms.append("i-1", msg(1));
  rooms.leave("i-1", "a");
  assert.deepEqual(rooms.join("i-1", "b"), [msg(1)]);
  assert.equal(t.count(), 0, "timer cancelado");
});

test("sala com clientes não agenda remoção; leave de cliente desconhecido é ignorado", () => {
  const t = fakeTimers();
  const rooms = createRoomRegistry({ timers: t.timers });
  rooms.join("i-1", "a");
  rooms.join("i-1", "b");
  rooms.leave("i-1", "a");
  rooms.leave("i-1", "zzz");
  rooms.leave("i-x", "a");
  assert.equal(t.count(), 0);
  assert.deepEqual(rooms.clients("i-1"), ["b"]);
});

test("clear remove tudo e cancela timers", () => {
  const t = fakeTimers();
  const rooms = createRoomRegistry({ timers: t.timers });
  rooms.join("i-1", "a");
  rooms.leave("i-1", "a");
  rooms.join("i-2", "b");
  rooms.clear();
  assert.equal(rooms.size(), 0);
  assert.equal(t.count(), 0);
});

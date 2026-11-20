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
    run() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
  };
}

const msg = (n, authorId = "ana") => ({ id: `m${n}`, author: { id: authorId }, text: String(n) });

test("findByNonce devolve a mensagem do mesmo autor com o mesmo nonce", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  const m = msg(1);
  rooms.append("i-1", m, "n-1");
  assert.equal(rooms.findByNonce("i-1", "ana", "n-1"), m);
  assert.equal(rooms.findByNonce("i-1", "ana", "n-2"), undefined);
});

test("o mesmo nonce de autores diferentes não colide", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  const daAna = msg(1, "ana");
  const doBruno = msg(2, "bruno");
  rooms.append("i-1", daAna, "igual");
  rooms.append("i-1", doBruno, "igual");
  assert.equal(rooms.findByNonce("i-1", "ana", "igual"), daAna);
  assert.equal(rooms.findByNonce("i-1", "bruno", "igual"), doBruno);
  assert.equal(rooms.findByNonce("i-1", "carla", "igual"), undefined);
});

test("autor e nonce não se confundem quando concatenados (sem colisão de chave)", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  rooms.append("i-1", msg(1, "a"), "b_c");
  assert.equal(rooms.findByNonce("i-1", "a_b", "c"), undefined);
  assert.equal(rooms.findByNonce("i-1", "ab", "_c"), undefined);
});

test("o índice é por sala: o mesmo autor e nonce em outra sala não é encontrado", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c1");
  rooms.join("i-2", "c2");
  rooms.append("i-1", msg(1), "n-1");
  assert.equal(rooms.findByNonce("i-2", "ana", "n-1"), undefined);
});

test("mensagens sem nonce não entram no índice", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  rooms.append("i-1", msg(1));
  rooms.append("i-1", msg(2), undefined);
  assert.equal(rooms.nonceCount("i-1"), 0);
  assert.equal(rooms.history("i-1").length, 2);
});

test("o objeto da mensagem não recebe o nonce (só o índice privado)", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  const m = msg(1);
  rooms.append("i-1", m, "segredo");
  assert.equal("nonce" in m, false);
  assert.equal("nonce" in rooms.history("i-1")[0], false);
});

test("retenção: o nonce expira junto com a mensagem que sai do histórico", () => {
  const rooms = createRoomRegistry({ historyLimit: 3 });
  rooms.join("i-1", "c");
  for (let i = 1; i <= 4; i++) rooms.append("i-1", msg(i), `n-${i}`);
  assert.equal(rooms.findByNonce("i-1", "ana", "n-1"), undefined, "m1 saiu do histórico");
  assert.equal(rooms.findByNonce("i-1", "ana", "n-2")?.id, "m2");
  assert.equal(rooms.nonceCount("i-1"), 3, "o índice não cresce além do histórico");
});

test("retenção: remover a sala vazia apaga o índice", () => {
  const t = fakeTimers();
  const rooms = createRoomRegistry({ timers: t.timers });
  rooms.join("i-1", "c");
  rooms.append("i-1", msg(1), "n-1");
  rooms.leave("i-1", "c");
  t.run();
  rooms.join("i-1", "c");
  assert.equal(rooms.findByNonce("i-1", "ana", "n-1"), undefined);
});

test("historyFor: o nonce aparece só nas mensagens do próprio viewer", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  rooms.append("i-1", msg(1, "ana"), "nonce-da-ana");
  rooms.append("i-1", msg(2, "bruno"), "nonce-do-bruno");
  rooms.append("i-1", msg(3, "ana"));

  const paraAna = rooms.historyFor("i-1", "ana");
  assert.equal(paraAna[0].nonce, "nonce-da-ana");
  assert.equal("nonce" in paraAna[1], false);
  assert.equal("nonce" in paraAna[2], false, "mensagem da Ana enviada sem nonce");

  const paraBruno = rooms.historyFor("i-1", "bruno");
  assert.equal("nonce" in paraBruno[0], false);
  assert.equal(paraBruno[1].nonce, "nonce-do-bruno");

  const paraCarla = rooms.historyFor("i-1", "carla");
  assert.ok(paraCarla.every((m) => !("nonce" in m)));
  assert.ok(!JSON.stringify(paraCarla).includes("nonce-"));
});

test("historyFor devolve cópias: alterar o resultado não altera a sala", () => {
  const rooms = createRoomRegistry();
  rooms.join("i-1", "c");
  rooms.append("i-1", msg(1), "n-1");
  const view = rooms.historyFor("i-1", "ana");
  view.push(msg(99));
  view[0].text = "alterado";
  assert.equal(rooms.history("i-1").length, 1);
  assert.equal(rooms.history("i-1")[0].text, "1");
});

test("historyFor de sala inexistente é vazio", () => {
  assert.deepEqual(createRoomRegistry().historyFor("i-x", "ana"), []);
});

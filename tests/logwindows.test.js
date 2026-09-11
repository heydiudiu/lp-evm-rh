// ОБРЫВ ПЕРЕБОРА ОКОН ТЕРЯЛ ЗАКРЫТИЯ ПОЗИЦИЙ.
//
// 11.09.2026 отчёт по сделкам сказал «закрытие не нашёл» по четырём позициям,
// хотя в цепочке они закрыты — я потом нашёл их руками. Узел отвечал «log
// query timed out» на широком окне, и перебор обрывался на первой неудаче:
// всё, что лежало дальше, не читалось молча.
//
// Тест держит новое поведение: неудачное окно делится пополам, а событие,
// лежащее ЗА ним, обязано найтись.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');
C.useChain('robinhood');

const ID = 12345n;
const salt = ID.toString(16).padStart(64, '0');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const signed = (v) => (BigInt(v) < 0n ? (1n << 256n) + BigInt(v) : BigInt(v))
  .toString(16).padStart(64, '0');

// Событие ModifyLiquidity: нам важны третье слово (дельта) и последнее (salt).
const evt = (block, delta) => ({
  blockNumber: '0x' + block.toString(16),
  transactionHash: '0x' + block.toString(16).padStart(64, '0'),
  data: '0x' + word(0) + word(0) + signed(delta) + word(0) + salt,
});

// Вход в блоке 1000, выход в 130000 — заведомо за пределами первого окна.
const CHAIN = [evt(1000, 5000), evt(130000, -5000)];

// wideFails — с какой ширины узел давится; deadFrom — с какого блока он не
// отвечает вовсе, хоть по одному блоку спрашивай.
function fakeRpc({ wideFails, deadFrom = Infinity }) {
  return async (method, params) => {
    if (method === 'eth_blockNumber') return '0x' + (200000).toString(16);
    if (method !== 'eth_getLogs') throw new Error('лишний вызов ' + method);
    const f = params[0];
    const from = Number(BigInt(f.fromBlock));
    const to = f.toBlock === 'latest' ? 200000 : Number(BigInt(f.toBlock));
    const span = to - from;
    // Узел давится широкими окнами; насколько широкими — задаём тестом.
    if (span >= wideFails || from >= deadFrom) throw new Error('log query timed out');
    return CHAIN.filter(e => {
      const b = Number(BigInt(e.blockNumber));
      return b >= from && b <= to;
    });
  };
}

test('событие за неудачным окном всё равно находится', async () => {
  // Широкое окно (весь диапазон и куски по 50 000) отваливается, а после
  // деления пополам узел отвечает.
  const rpc = fakeRpc({ wideFails: 30000 });
  const byId = await C.readPositionEvents(rpc, '0x' + word(1), 0, [ID.toString()]);
  const list = byId.get(ID.toString()) || [];
  assert.strictEqual(list.length, 2, 'должны найтись и вход, и выход');
  assert.ok(list.some(x => x.delta < 0n), 'выход обязан найтись');
  assert.ok(!byId.missed, 'непрочитанных окон быть не должно');
});

test('если окно не читается совсем — об этом сказано вслух', async () => {
  // Узел не отвечает ни на каком размере окна начиная с блока 100 000.
  const rpc = fakeRpc({ wideFails: 30000, deadFrom: 100000 });
  const byId = await C.readPositionEvents(rpc, '0x' + word(1), 0, [ID.toString()]);
  assert.ok(byId.missed > 0, 'пропущенные окна обязаны быть посчитаны');
  // Вход, лежащий в читаемой части, всё равно найден.
  const list = byId.get(ID.toString()) || [];
  assert.ok(list.length >= 1, 'читаемая часть журнала обязана прочитаться');
});

test('служебный счётчик не выглядит как ещё одна позиция', async () => {
  const rpc = fakeRpc({ wideFails: 30000, deadFrom: 100000 });
  const byId = await C.readPositionEvents(rpc, '0x' + word(1), 0, [ID.toString()]);
  for (const k of byId.keys()) assert.match(k, /^\d+$/, 'ключ обязан быть номером позиции');
});

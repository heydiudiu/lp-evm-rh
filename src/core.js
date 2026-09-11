// Ядро терминала: чтение сети и математика Uniswap V4.
//
// Здесь НЕТ работы со страницей и НЕТ подписи. Только чистые вычисления и
// запросы на чтение. Такой файл можно прогнать в node на живой сети и
// сверить с независимым расчётом — что я и делаю в tests/.
//
// Всё, что здесь есть, уже проверено на настоящих позициях автора
// 03.09.2026: адреса, селекторы, пересчёт PoolId, чтение цены, шаг тика.

'use strict';

// ДВЕ СЕТИ В ОДНОМ ТЕРМИНАЛЕ.
//
// Uniswap V4 устроен одинаково везде: singleton PoolManager, тот же
// PositionManager, те же действия в calldata. Значит и терминал нужен один,
// а сеть — это набор адресов и особенностей узла, а не отдельная программа.
//
// Адреса ТОЛЬКО в нижнем регистре: дальше в коде они сравниваются с тем, что
// вернул узел, без приведения регистра, и контрольная сумма EIP-55 сломала бы
// сравнение молча.
const CHAINS = {
  robinhood: {
    key: 'robinhood',
    label: 'Robinhood',
    chainId: 4663,
    // Проверено на сети: у всех есть код; PositionManager и StateView
    // независимо указывают на этот же PoolManager; байткод совпадает с
    // официальным развёртыванием в Base с точностью до вшитых адресов.
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    publicRpc: 'https://rpc.mainnet.chain.robinhood.com',
    blockSec: 2,
    nativeSymbol: 'ETH',
    // Публичный узел этой сети отдаёт журнал на любую глубину — это редкость
    // и это подарок: история позиций читается без своего узла.
    deepLogs: true,
    // Список пулов монеты берём из DexScreener: он эту сеть знает.
    poolSource: 'dexscreener',
    dexscreenerChain: 'robinhood',
    rpcHint: 'https://robinhood-mainnet.g.alchemy.com/v2/…',
    // Чем заходят в пулы на этой сети. Нужен, чтобы показать кошелёк ДО
    // загрузки пула: человек должен видеть, с чем он может работать.
    wallet: [
      { addr: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', sym: 'USDG', dec: 6 },
    ],
    // Память браузера. Ключи РАЗНЫЕ у разных сетей, и менять их нельзя:
    // в журнале входов лежат суммы, по которым считается итог позиции.
    storeKey: 'lp-evm-rh',
    ledgerKey: 'lp-evm-rh-ledger',
  },
  bsc: {
    key: 'bsc',
    label: 'BNB Chain',
    chainId: 56,
    // Проверено на цепочке 08.09.2026: у всех троих есть код, а
    // PositionManager и StateView независимо возвращают этот же PoolManager.
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    positionManager: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
    stateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    // Публичные узлы BSC к eth_getLogs недружелюбны: dataseed отвечает
    // «limit exceeded» и событий не отдаёт вовсе, 1rpc и blockrazor режут
    // отрезок, drpc отваливается по таймауту. Этот события отдаёт — но
    // только недавние блоки. За историей нужен свой узел.
    publicRpc: 'https://bsc-rpc.publicnode.com',
    blockSec: 0.75,
    nativeSymbol: 'BNB',
    deepLogs: false,
    // DexScreener пулы Uniswap V4 в этой сети не показывает ВООБЩЕ — отдаёт
    // только пары V2 и V3. Поэтому GeckoTerminal, и строго площадка
    // uniswap-v4-bsc: у PancakeSwap Infinity идентификаторы тоже 32-байтные,
    // но singleton другой, и такой пул увёл бы транзакцию не туда.
    poolSource: 'geckoterminal',
    geckoNetwork: 'bsc',
    geckoDex: 'uniswap-v4-bsc',
    rpcHint: 'https://bnb-mainnet.g.alchemy.com/v2/… (свой узел — глубже история)',
    wallet: [
      { addr: '0x55d398326f99059ff775485246999027b3197955', sym: 'USDT', dec: 18 },
      { addr: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', sym: 'USDC', dec: 18 },
    ],
    storeKey: 'lp-bsc',
    ledgerKey: 'lp-bsc-ledger',
    // Сколько недавних блоков спрашивать у журнала. Узел хранит немного;
    // 5000 блоков это около часа и один запрос вместо двух десятков отказов.
    logsWindow: 5000,
    // Для поиска выпуска позиции окно шире: фильтр по номеру предельно узкий,
    // ответ крошечный, а позиция могла открыться несколько часов назад.
    mintWindow: 60000,
    // Вход в пары с нативной монетой СОБРАН 09.09.2026: она уходит значением
    // транзакции, сдачу возвращает SWEEP. Проверено симуляцией на живом пуле
    // CTM/BNB: с value проходит, без value — откат, то есть работает именно
    // значение, а не случайность. Живыми деньгами ещё не проверялось.
    nativeEntryBlocked: false,
  },
};

// АКТИВНАЯ СЕТЬ. Имя RH историческое — раньше сеть была одна. Это живой
// объект: переключение подменяет его поля, поэтому все ссылки на RH по коду
// остаются верными и переписывать их не нужно.
const RH = {};
function useChain(name) {
  const c = CHAINS[name] || CHAINS.robinhood;
  for (const k of Object.keys(RH)) delete RH[k];
  Object.assign(RH, c);
  return RH;
}
useChain('robinhood');

// Селекторы посчитаны из подписей, keccak сверен с эталоном.
const SEL = {
  poolKeys: '0x86b6be7d',                 // poolKeys(bytes25)
  getSlot0: '0xc815641c',                 // getSlot0(bytes32)
  getPoolAndPositionInfo: '0x7b1b1b1b',   // заполняется при инициализации
  modifyLiquidities: '0xdd46508f',        // modifyLiquidities(bytes,uint256)
  poolManager: '0xdc4c90d3',
  getPositionLiquidity: '0x1efeed33',
  getPoolAndPositionInfo: '0x7ba03aad',
  getFeeGrowthInside: '0x53e9c1fb',       // getFeeGrowthInside(bytes32,int24,int24)
  getLiquidity: '0xfa6793d5',             // getLiquidity(bytes32)
  getTickBitmap: '0x1c7ccb4c',            // getTickBitmap(bytes32,int16)
  getTickLiquidity: '0xcaedab54',         // getTickLiquidity(bytes32,int24)
  getPositionInfo: '0x97fd7b42',          // getPositionInfo(bytes32,bytes32)
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  p2approve: '0x87517c45',                // Permit2.approve(address,address,uint160,uint48)
  p2allowance: '0x927da105',              // Permit2.allowance(address,address,address)
};

// Коды действий PositionManager. Значения сверены с Actions.sol.
// ВНИМАНИЕ: 0x04 и 0x05 (*_FROM_DELTAS) в текущем коде Uniswap помечены как
// уязвимые к сэндвич-атакам. Не использовать никогда.
// Значения подтверждены разбором НАСТОЯЩИХ транзакций автора:
// вход  — 0x02 0x0d (MINT_POSITION, SETTLE_PAIR)
// выход — 0x01 0x11 (DECREASE_LIQUIDITY, TAKE_PAIR)
const ACTION = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  // Возврат сдачи в нативной монете. Нужен там, где одна сторона пары —
  // сам BNB: его нельзя провести через Permit2, он идёт значением
  // транзакции, а значение всегда округляется вверх с запасом.
  SWEEP: 0x14,
};

// Особые адреса-получатели в PositionManager: 1 означает «тому, кто прислал
// транзакцию». В настоящей транзакции закрытия стоит именно единица.
const MSG_SENDER = '0x0000000000000000000000000000000000000001';

const MIN_TICK = -887272;
const MAX_TICK = 887272;

// ── мелочи ───────────────────────────────────────────────────────────────
const hex = (n, bytes = 32) => BigInt(n).toString(16).padStart(bytes * 2, '0');
const stripHex = (s) => (s.startsWith('0x') ? s.slice(2) : s);
const addrWord = (a) => stripHex(a).toLowerCase().padStart(64, '0');

function toSigned(v, bits) {
  const b = BigInt(bits);
  const m = 1n << (b - 1n);
  return v >= m ? v - (1n << b) : v;
}

function words(hexStr) {
  const s = stripHex(hexStr);
  const out = [];
  for (let i = 0; i < s.length; i += 64) out.push(s.slice(i, i + 64));
  return out;
}

// ── математика тиков ─────────────────────────────────────────────────────
//
// Точная реализация Uniswap TickMath на целых числах. Приблизительная
// (через Math.pow) здесь недопустима: ошибка в младших разрядах цены — это
// сдвинутая граница позиции, то есть деньги.
const Q96 = 1n << 96n;

function getSqrtRatioAtTick(tick) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`тик вне допустимого: ${tick}`);
  }
  const abs = BigInt(Math.abs(tick));
  let ratio = (abs & 0x1n) !== 0n
    ? 0xfffcb933bd6fad37aa2d162d1a594001n
    : 0x100000000000000000000000000000000n;
  const mul = (r, c) => (r * c) >> 128n;
  if ((abs & 0x2n) !== 0n) ratio = mul(ratio, 0xfff97272373d413259a46990580e213an);
  if ((abs & 0x4n) !== 0n) ratio = mul(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((abs & 0x8n) !== 0n) ratio = mul(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((abs & 0x10n) !== 0n) ratio = mul(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((abs & 0x20n) !== 0n) ratio = mul(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((abs & 0x40n) !== 0n) ratio = mul(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((abs & 0x80n) !== 0n) ratio = mul(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((abs & 0x100n) !== 0n) ratio = mul(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((abs & 0x200n) !== 0n) ratio = mul(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((abs & 0x400n) !== 0n) ratio = mul(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((abs & 0x800n) !== 0n) ratio = mul(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((abs & 0x1000n) !== 0n) ratio = mul(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((abs & 0x2000n) !== 0n) ratio = mul(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((abs & 0x4000n) !== 0n) ratio = mul(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((abs & 0x8000n) !== 0n) ratio = mul(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((abs & 0x10000n) !== 0n) ratio = mul(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((abs & 0x20000n) !== 0n) ratio = mul(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((abs & 0x40000n) !== 0n) ratio = mul(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((abs & 0x80000n) !== 0n) ratio = mul(ratio, 0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  // из Q128.128 в Q96, с округлением вверх — как в оригинале
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}

// Сколько ликвидности даст сумма одного токена на участке.
// Формулы из LiquidityAmounts; округление ВНИЗ, чтобы не запросить больше,
// чем есть.
function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const inter = (sqrtA * sqrtB) / Q96;
  return (amount0 * inter) / (sqrtB - sqrtA);
}

function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

// Сколько токенов лежит в позиции при текущей цене.
//
// Три случая: цена ниже диапазона — всё в currency0; выше — всё в currency1;
// внутри — смесь. Формулы из LiquidityAmounts, целочисленные.
//
// Именно это и означает «перелилось»: пока цена шла через диапазон, один
// токен превращался в другой.
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  let amount0 = 0n, amount1 = 0n;
  if (sqrtP <= sqrtA) {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtA)) / (sqrtB * sqrtA);
  } else if (sqrtP < sqrtB) {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtP)) / (sqrtB * sqrtP);
    amount1 = (liquidity * (sqrtP - sqrtA)) / Q96;
  } else {
    amount1 = (liquidity * (sqrtB - sqrtA)) / Q96;
  }
  return { amount0, amount1 };
}

// ── диапазон в СТУПЕНЬКАХ, а не в процентах ──────────────────────────────
//
// Это главный вывод проверки 03.09. Граница встаёт только на кратный
// tickSpacing тик. В пулах автора шаг 415, 500 и 1000 тиков — то есть
// 4.06%, 4.88% и 9.52% по цене. Отступ «3%» там не существует: он либо
// округлится к нулю (и позиция перестанет быть односторонней), либо до
// целой ступеньки.
//
// Поэтому считаем в ступеньках и ВСЕГДА округляем наружу от цены, а нулевой
// отступ запрещаем.
function planRange({ tick, tickSpacing, widthPct, gapPct, side }) {
  if (!(tickSpacing > 0)) throw new Error('шаг тика не прочитан');
  const toTicks = (p) => Math.log(1 + p / 100) / Math.log(1.0001);
  const step = (t) => t * tickSpacing;

  // Сетка тиков привязана к нулю, поэтому ближайшая допустимая граница ниже
  // цены — это floor(tick / шаг) * шаг. Расстояние до неё уже ненулевое, и
  // добавлять целую ступеньку сверху не всегда нужно: при отступе 3% и шаге
  // 500 это давало 8.61% вместо 4.88%, то есть вдвое шире, чем просили.
  //
  // Берём МИНИМАЛЬНОЕ число ступенек, при котором отступ уже не меньше
  // запрошенного, и требуем строгого неравенства с текущим тиком: граница
  // обязана быть по свою сторону, иначе позиция перестаёт быть односторонней.
  const base = Math.floor(tick / tickSpacing) * tickSpacing;
  let tickLower, tickUpper;
  if (side === 'down') {
    const wantGap = toTicks(-gapPct);            // отрицательное
    let k = 0;
    while (base - k * tickSpacing >= tick || (base - k * tickSpacing) - tick > wantGap) {
      k += 1;
      if (k > 10000) throw new Error('не подобрал отступ');
    }
    tickUpper = base - k * tickSpacing;
    const wantWidth = toTicks(-widthPct);
    let m = k + 1;
    while ((base - m * tickSpacing) - tick > wantWidth) {
      m += 1;
      if (m > 100000) throw new Error('не подобрал ширину');
    }
    tickLower = base - m * tickSpacing;
  } else if (side === 'up') {
    const top = base + tickSpacing;              // ближайшая граница выше цены
    const wantGap = toTicks(gapPct);
    let k = 0;
    while (top + k * tickSpacing <= tick || (top + k * tickSpacing) - tick < wantGap) {
      k += 1;
      if (k > 10000) throw new Error('не подобрал отступ');
    }
    tickLower = top + k * tickSpacing;
    const wantWidth = toTicks(widthPct);
    let m = k + 1;
    while ((top + m * tickSpacing) - tick < wantWidth) {
      m += 1;
      if (m > 100000) throw new Error('не подобрал ширину');
    }
    tickUpper = top + m * tickSpacing;
  } else {
    throw new Error('сторона должна быть down или up');
  }
  if (tickLower >= tickUpper) throw new Error('диапазон вышел пустым');
  const loSteps = (tickLower - base) / tickSpacing;
  const hiSteps = (tickUpper - base) / tickSpacing;

  const pct = (t) => (Math.pow(1.0001, t - tick) - 1) * 100;
  return {
    tickLower, tickUpper,
    gapReal: pct(side === 'down' ? tickUpper : tickLower),
    widthReal: pct(side === 'down' ? tickLower : tickUpper),
    minGap: (Math.pow(1.0001, side === 'down' ? -tickSpacing : tickSpacing) - 1) * 100,
    oneSided: side === 'down' ? tickUpper <= tick : tickLower > tick,
    steps: { lo: loSteps, hi: hiSteps },
  };
}

// ── ПРОЦЕНТЫ: ПОКАЗАННАЯ ЦЕНА ПРОТИВ СЫРОЙ ───────────────────────────────
//
// Тик считает currency1 за currency0. Когда стейбл стоит ПЕРВЫМ, показанная
// человеку цена перевёрнута, и «вниз» в ней означает «вверх» в тиках.
//
// Границы диапазона я под это уже правил. Проценты — нет, и на USDG/ROBINCAT
// это стоило неверного размещения: автор просил ширину 50%, планировщик
// честно отложил +50% в СЫРОЙ цене, а на графике вышло −34.7%, потому что
// 1/1.5314 = 0.653. Автор померил по свечам −32% и справедливо спросил,
// где обещанные пятьдесят.
//
// Здесь эти функции живут ради проверок: это арифметика про деньги, и её
// нельзя держать там, куда тест не дотянется.

// Процент, введённый в показанной цене → положительная величина для planRange.
// below — диапазон уходит НИЖЕ показанной цены.
function askedToRawPct(pct, below, inverted) {
  const F = below ? 1 - pct / 100 : 1 + pct / 100;
  if (!(F > 0)) throw new Error('процент слишком велик: цена не может уйти в ноль');
  const raw = inverted ? 1 / F : F;
  return Math.abs(raw - 1) * 100;
}

// Обратно: то, что вернул planRange, — в проценты показанной цены.
function rawToShownPct(rawPct, inverted) {
  const F = 1 + rawPct / 100;
  const d = inverted ? (F ? 1 / F : 0) : F;
  return (d - 1) * 100;
}

// ── ПУЛЫ МОНЕТЫ ПРЯМО ИЗ ЦЕПОЧКИ ─────────────────────────────────────────
//
// Список пулов монеты берётся из сводки DexScreener, и это единственное
// место, где терминал зависит от чужого сервера. Когда сводка не отвечает —
// а с телефона это бывает, — кнопка «Загрузить пул» выглядит мёртвой.
//
// Между тем всё нужное лежит в цепочке: у события Initialize ОБЕ стороны
// пары проиндексированы, поэтому найти все пулы монеты стоит двух запросов
// по всей истории, независимо от её глубины.
//
// Чего здесь нет и не будет: оборота и глубины. Их цепочка не хранит, и
// считать их обходом всех обменов слишком дорого. Поэтому это запасной путь:
// список полный, но без сортировки по объёму.
const INIT_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

// from — с какого блока искать. По всей истории лезть НЕ НАДО: новую монету
// вставляют через часы после её появления, а полная история — это 55 млн
// блоков, и на приболевшем узле деление такого отрезка растягивается на
// минуты. Автор ждал пять минут и не дождался. Сначала смотрим свежее.
//
// budget — потолок запросов на каждую из двух сторон пары.
async function poolsOfToken(rpc, token, latest, from = 0, budget = 12) {
  const pad = '0x' + addrWord(token);
  const out = new Map();
  for (const topics of [[INIT_TOPIC, null, pad], [INIT_TOPIC, null, null, pad]]) {
    let logs = [];
    try {
      logs = await getLogsSplit(rpc, { address: RH.poolManager, topics },
                                Math.max(0, from), latest, { left: budget });
    } catch (e) { continue; }
    for (const l of logs) {
      const id = (l.topics[1] || '').toLowerCase();
      if (!id) continue;
      const w = words(l.data);
      out.set(id, {
        poolId: id,
        currency0: '0x' + (l.topics[2] || '').slice(26),
        currency1: '0x' + (l.topics[3] || '').slice(26),
        fee: Number(BigInt('0x' + w[0])),
        tickSpacing: Number(toSigned(BigInt('0x' + w[1]), 256)),
        hooks: '0x' + w[2].slice(24),
        block: Number(BigInt(l.blockNumber)),
      });
    }
  }
  // Свежие первыми: у монеты, которой пара дней, старых пулов и не бывает,
  // а у старой свежий пул обычно и есть живой.
  return [...out.values()].sort((a, b) => b.block - a.block);
}

// ── свои позиции, БЕЗ обозревателя ───────────────────────────────────────
//
// Раньше список брался у Blockscout, и он не работал никогда: обозреватель
// не отдаёт заголовок CORS, поэтому браузер не может прочитать его ответ.
// Позиции показывались только те, что мы сами записали при входе.
//
// Теперь берём из журнала событий сети через твой же узел: все переводы
// NFT позиции НА твой адрес. Это работает всегда и ни от кого не зависит.
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Узел отказывает по ДВУМ разным причинам, и лечатся они по-разному.
//
// 1. Слишком много СОВПАВШИХ событий: публичный узел Robinhood отвечает
//    «logs matched by query exceeds limit of 10000», а иногда — просто
//    «internal server error», что автор и видел на экране как
//    «узел не отдал историю». Повторять такой запрос бессмысленно: отказ
//    детерминированный, и три попытки дают три одинаковых отказа.
//    Лечится ТОЛЬКО делением отрезка пополам.
// 2. Слишком широкий отрезок БЛОКОВ: этим страдает бесплатный Alchemy
//    (10 блоков за раз). Лечится тем же делением.
//
// Поэтому делим рекурсивно, пока запрос не пройдёт. Ограничитель глубины
// нужен, чтобы отказ по другой причине не превратился в тысячу запросов.
// ОСТОРОЖНО С «too many». Первая версия ловила эту пару слов целиком — и
// заодно ловила «Too Many Requests», то есть ограничение по ЧАСТОТЕ. Отвечать
// на «слишком часто» делением запроса надвое значит удвоить частоту; узел
// закономерно отвечал отказом, и тест это поймал. Поэтому предел частоты
// исключён явной проверкой и никогда не приводит к делению.
const RATE_LIMIT_RE = /too many requests|rate limit|429/i;
// ВНИМАНИЕ НА ОПЕЧАТКУ УЗЛА. Он отвечает буквально «internal server errror»
// — с тремя «р». Шаблон был написан по правильному написанию и НЕ СОВПАДАЛ,
// поэтому деление отрезка не запускалось вовсе: запрос просто падал. На
// экране это выглядело как «узел не отдал события обмена» у пулов с
// миллионными оборотами, и автор справедливо сказал, что такого быть не может.
const LOGS_CAP_RE =
  /exceeds limit|too many (results|logs|events)|more than|response size|too large|internal server err+or|block range|query returned|limited to|must not exceed|maximum block/i;

// ОТКАЗ ПО ГЛУБИНЕ — НЕ ТО ЖЕ, ЧТО ОТКАЗ ПО ОБЪЁМУ.
//
// Публичные узлы BSC держат только недавние блоки и на старый fromBlock
// отвечают «archive requests require a personal token». Делить такой отрезок
// пополам бессмысленно: старая половина будет отказывать до самого дна, сжигая
// бюджет запросов. Правильный ответ — взять только НОВУЮ половину и честно
// сказать, насколько глубоко удалось заглянуть.
const ARCHIVE_RE = /archive|state (is )?not available|missing trie|pruned/i;

// Делению нужен потолок по ЧИСЛУ ЗАПРОСОВ, а не только по глубине. Первая
// версия его не имела: запрос без фильтра развалился на сотни кусков, и узел
// ответил «Too Many Requests» — деление, задуманное как лекарство, само
// превратилось в обстрел общего узла. Потолок общий на весь верхний вызов.
async function getLogsSplit(rpc, filter, from, to, state = null) {
  const st = state || { left: 48 };
  if (st.left <= 0) {
    throw new Error('журнал не читается: отрезок пришлось бы делить слишком мелко');
  }
  st.left--;
  try {
    return await rpc('eth_getLogs', [{
      ...filter,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }]);
  } catch (e) {
    const msg = e.message || '';
    // Не наша ошибка либо делить уже нечего — отдаём как есть. «Too Many
    // Requests» сюда не попадает намеренно: это не предел размера ответа,
    // и деление его только усугубит.
    if (to - from < 4 || RATE_LIMIT_RE.test(msg)) throw e;
    const mid = Math.floor((from + to) / 2);
    // Узел не хранит такую глубину: старую половину даже не пробуем.
    if (ARCHIVE_RE.test(msg)) return getLogsSplit(rpc, filter, mid + 1, to, st);
    if (!LOGS_CAP_RE.test(msg)) throw e;
    // Половинки идут ПО ОЧЕРЕДИ, а не параллельно: узел общий, и одновременный
    // залп — прямой путь к «Too Many Requests».
    const a = await getLogsSplit(rpc, filter, from, mid, st);
    const b = await getLogsSplit(rpc, filter, mid + 1, to, st);
    return a.concat(b);
  }
}

// Узлы ограничивают глубину одного запроса к журналу: Alchemy отвергает
// большие отрезки. Поэтому идём ОКНАМИ назад от текущего блока, пока не
// наберём нужную глубину или пока узел не начнёт отказывать.
async function scanLogs(rpc, filter, latest, depth, windowSize) {
  const out = [];
  let why = null;
  for (let end = latest; end > latest - depth; end -= windowSize) {
    const start = Math.max(0, end - windowSize + 1);
    try {
      out.push(...await getLogsSplit(rpc, filter, start, end));
    } catch (e) {
      why = (e.message || '').slice(0, 90);
      break;
    }
  }
  return { logs: out, why };
}

async function readMyPositions(rpc, owner, depth = 60000, windowSize = 2000) {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const { logs, why } = await scanLogs(rpc, {
    address: RH.positionManager,
    topics: [TRANSFER_TOPIC, null, '0x' + addrWord(owner)],
  }, latest, depth, windowSize);
  const ids = [...new Set(logs.map(l => BigInt(l.topics[3]).toString()))];
  return { ids, scanned: !why || ids.length > 0, why };
}

// ── история: сколько внёс и сколько забрал ───────────────────────────────
//
// Берём из журнала событий сети все переводы токенов МЕЖДУ кошельком и
// PoolManager. Туда — вход, оттуда — выход. Обозреватель не нужен, всё
// читается через узел автора.
//
// Это честнее любых наших записей: показывает, что реально двигалось.
// ВАЖНО ПРО ФИЛЬТР. Запрос к журналу БЕЗ указания контрактов заставляет узел
// просматривать все события сети — Alchemy такие запросы отклоняет, и история
// приходила пустой. Поэтому передаём список токенов: тогда узел смотрит
// только их.
async function readHistory(rpc, owner, tokens = [], depth = 60000, windowSize = 2000) {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const pad = (a) => '0x' + addrWord(a);
  const addr = tokens.length ? { address: tokens } : {};
  const a = await scanLogs(rpc, { ...addr, topics: [TRANSFER_TOPIC, pad(owner), pad(RH.poolManager)] },
                           latest, depth, windowSize);
  const b = await scanLogs(rpc, { ...addr, topics: [TRANSFER_TOPIC, pad(RH.poolManager), pad(owner)] },
                           latest, depth, windowSize);
  if (!a.logs.length && !b.logs.length && (a.why || b.why)) {
    const err = new Error(a.why || b.why);
    err.rpcRefused = true;
    throw err;
  }
  const logs = [...a.logs.map(l => ({ ...l, dir: -1 })),
                ...b.logs.map(l => ({ ...l, dir: 1 }))];
  if (!logs.length) return [];
  // группируем по транзакции
  const byTx = new Map();
  for (const l of logs) {
    const k = l.transactionHash;
    if (!byTx.has(k)) byTx.set(k, { hash: k, block: Number(BigInt(l.blockNumber)), items: [] });
    byTx.get(k).items.push({
      token: '0x' + l.address.slice(2).toLowerCase(),
      amount: BigInt(l.data === '0x' ? '0x0' : l.data),
      dir: l.dir,
    });
  }
  return [...byTx.values()].sort((a, b) => b.block - a.block);
}

// ── факты сделки берём с цепочки, а не из памяти браузера ────────────────
//
// Вход записывался в память браузера. Открыл другой браузер, почистил кэш,
// зашёл не через терминал — и позиция пишет «вход не записан», а время в
// позиции пропадает. Память браузера не годится в источник правды о деньгах.
//
// Правда лежит в цепочке. Позиция — это NFT, и его выпуск виден одним
// событием. На узле Robinhood запрос по номеру NFT сразу по ВСЕЙ истории
// (53 млн блоков) отвечает за ~120 мс: фильтр по теме сужает поиск до одной
// записи, поэтому глубина ничего не стоит.
// ПОИСК ВЫПУСКА ПОЗИЦИИ.
//
// Раньше здесь стоял запрос с нулевого блока «по всю историю». В сети
// Robinhood это дёшево: фильтр по номеру позиции предельно узкий, узел
// отдаёт мгновенно. А узел BSC на такой запрос отвечает отказом по глубине —
// и вход просто «не находился». Автор увидел это на своей первой живой
// позиции в BSC: в колонке итога стояло «вход в цепочке не найден».
//
// Поэтому: там, где узел держит всю историю, спрашиваем как раньше; где не
// держит — берём разумное недавнее окно и позволяем делению отрезка самому
// сузиться до того, что узел отдаёт.
async function findMint(rpc, tokenId, fromBlock) {
  const id = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  const filter = { address: RH.positionManager,
                   topics: [TRANSFER_TOPIC, null, null, id] };
  let logs;
  if (fromBlock == null || fromBlock === 0) {
    logs = await rpc('eth_getLogs', [{ ...filter, fromBlock: '0x0', toBlock: 'latest' }]);
  } else {
    const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
    const from = fromBlock < 0 ? Math.max(0, latest + fromBlock) : fromBlock;
    logs = await getLogsSplit(rpc, filter, from, latest, { left: 20 });
  }
  if (!logs || !logs.length) return null;
  // Самое раннее событие по этому номеру и есть выпуск.
  let first = logs[0];
  for (const l of logs) {
    if (Number(BigInt(l.blockNumber)) < Number(BigInt(first.blockNumber))) first = l;
  }
  return { block: Number(BigInt(first.blockNumber)), hash: first.transactionHash };
}

// Что реально сдвинулось в этой транзакции между кошельком и пулом.
// Читаем расписку: там лежат все переводы токенов, и подделать их нельзя.
async function txFlows(rpc, hash, owner) {
  const rc = await rpc('eth_getTransactionReceipt', [hash]);
  if (!rc || !rc.logs) return null;
  const me = addrWord(owner).toLowerCase();
  const pm = addrWord(RH.poolManager).toLowerCase();
  const flows = [];
  for (const l of rc.logs) {
    if ((l.topics[0] || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    // У обычного токена три темы, у NFT позиции — четыре. NFT нам не нужен.
    if (l.topics.length !== 3) continue;
    const from = (l.topics[1] || '').slice(2).toLowerCase();
    const to = (l.topics[2] || '').slice(2).toLowerCase();
    let dir = 0;
    if (from === me && to === pm) dir = -1;          // внёс
    else if (from === pm && to === me) dir = 1;      // забрал
    else continue;
    flows.push({
      token: '0x' + l.address.slice(2).toLowerCase(),
      amount: BigInt(l.data === '0x' ? '0x0' : l.data),
      dir,
    });
  }
  return { block: Number(BigInt(rc.blockNumber)), flows };
}

// Событие обмена в пуле. В нём лежит цена ПОСЛЕ сделки — sqrtPriceX96.
// Тема посчитана от подписи
//   Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
// и проверена на живых событиях: цена из последнего события совпала с
// текущей ценой пула до последнего знака (0.00381833 USDG за GRASS).
const SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';

// Цена пула на нужном блоке.
//
// Именно этого не хватало для честного PnL. Восстанавливать цену из
// вернувшихся сумм — гадание, и оно давало «цену закрытия 1.000000».
// А здесь цена лежит готовой в каждом событии обмена, и события хранятся
// вечно: архивный узел не нужен (публичный узел старое состояние не отдаёт,
// проверено — «metadata is not found»).
//
// Идём окнами назад от нужного блока, пока не встретим обмен. У живого пула
// это первое же окно: 1035 событий на 20 000 блоков за 254 мс.
async function priceAtBlock(rpc, poolId, block, maxBack = 400000, windowSize = 20000) {
  for (let end = block; end > block - maxBack; end -= windowSize) {
    const start = Math.max(0, end - windowSize + 1);
    let logs = null;
    try {
      logs = await getLogsSplit(rpc, {
        address: RH.poolManager,
        topics: [SWAP_TOPIC, poolId],
      }, start, end);
    } catch (e) { return null; }
    if (logs && logs.length) {
      const l = logs[logs.length - 1];             // события идут по возрастанию
      const w = words(l.data);
      return {
        sqrtPriceX96: BigInt('0x' + w[2]),
        // 256, А НЕ 24. Слово в журнале — это int24, РАСШИРЕННЫЙ ЗНАКОМ до
        // 256 бит: у отрицательного тика оно выглядит как 0xffff…fb0d59.
        // При ширине 24 такое слово превращалось в 1.16e+77, и цена по нему
        // не считалась вовсе. Пулы с положительным тиком работали, с
        // отрицательным — молча нет; из-за этого 30 позиций из 124 выпали
        // из подсчёта итога. В readSlot0 рядом всегда стояло 256.
        tick: Number(toSigned(BigInt('0x' + w[4]), 256)),
        block: Number(BigInt(l.blockNumber)),
      };
    }
    if (start === 0) break;
  }
  return null;
}

async function blockTime(rpc, block) {
  const b = await rpc('eth_getBlockByNumber', ['0x' + block.toString(16), false]);
  return b && b.timestamp ? Number(BigInt(b.timestamp)) * 1000 : null;
}

// ── ПЛАТИТ ЛИ ПУЛ ВООБЩЕ ─────────────────────────────────────────────────
//
// Это самая дорогая проверка из всех, что тут есть, и появилась она после
// реального убытка. Автор зашёл в USDG/PIXELCAT — самый крупный пул пары,
// объём 11.4 млн за сутки — простоял в нём и вышел в минус 100 долларов,
// получив РОВНО НОЛЬ комиссий. Терминал показывал «комиссия 0.00%» и вердикт
// «годен»: поле он вывел честно, а вывод из него не сделал.
//
// Ноль в комиссии бывает по двум причинам, и обе означают одно и то же для
// поставщика ликвидности:
//   * в ключе пула стоит статический ноль — пул не берёт с обменов ничего;
//   * стоит флаг плавающей комиссии, а хук с правом «забирать часть обмена»
//     оставляет себе всё. Замерено: у таких пулов в событиях обмена
//     применённая комиссия ровно 0.000%.
// Проверять надо не поле в ключе, а ПРИМЕНЁННУЮ комиссию: в событии Swap
// последнее слово — та комиссия, что фактически взята с обмена. Пул с
// плавающей комиссией может и платить (замерено 0.045% на 102 обменах), так
// что судить по флагу нельзя — только по факту.
//
// Замер по паре PIXELCAT: первый по объёму пул платит 0.000%, а соседний,
// в три с половиной раза меньше по обороту, платит 4.096%. Сортировка по
// одному объёму ведёт прямо в тот, который не платит.
// Окно по умолчанию — 40 000 блоков. При блоке около 0.1 с это примерно час
// торговли. Первая версия брала 4000, то есть неполные семь минут, и три пула
// из двенадцати честно отвечали «обменов не было»: окно было короче, чем
// пауза между сделками, и замер превращался в «неизвестно» там, где ответ
// есть. Дороже это почти не стоит — у самого бойкого пула около 600 событий,
// а при перегрузе отрезок делится сам.
async function poolFeeReality(rpc, poolId, latest, window = 40000) {
  // ОТ МАЛОГО ОКНА К БОЛЬШОМУ, А НЕ НАОБОРОТ.
  //
  // Раньше сразу запрашивались 40 000 блоков, и при загрузке списка из восьми
  // пулов это восемь тяжёлых запросов подряд. Общий узел на такое отвечает
  // отказом, и на экране у всех пулов оказывалось «платит ли — неизвестно»
  // даже там, где обменов миллионы. Автор справедливо сказал: «этого не может
  // быть с пулами».
  //
  // У живого пула хватает и шести тысяч блоков (около десяти минут). Окно
  // расширяем, только если в маленьком обменов не нашлось, — то есть платим
  // за глубину лишь там, где она действительно нужна.
  const steps = [];
  for (let w = Math.min(6000, window); w <= window; w *= 5) steps.push(Math.round(w));
  if (!steps.length || steps[steps.length - 1] !== window) steps.push(window);

  let logs = null, from = latest, lastErr = null;
  for (const w of steps) {
    from = Math.max(0, latest - w);
    try {
      // БЮДЖЕТ НА ЗАПРОСЫ. Здесь не нужна полнота: достаточно увидеть
      // несколько недавних обменов и их комиссию. Когда узел болеет, деление
      // отрезка доходит до сорока запросов и сорока шести секунд — а список
      // из восьми пулов на это ждать нельзя. Лучше честно сказать
      // «неизвестно» через секунду, чем показать то же самое через минуту.
      logs = await getLogsSplit(rpc, {
        address: RH.poolManager,
        topics: [SWAP_TOPIC, poolId],
      }, from, latest, { left: 4 });
    } catch (e) {
      // Если узел отказал на МАЛЕНЬКОМ окне, большое ему тем более не по
      // силам. Расширяемся только после успешного, но пустого ответа.
      lastErr = e; logs = null; break;
    }
    if (logs.length) break;               // нашлись обмены — глубже не лезем
  }
  if (logs === null) {
    return { swaps: 0, pays: null,
             why: 'узел сейчас не отдаёт события обмена — повтори через минуту',
             blocks: latest - from };
  }
  const fees = logs.map(l => Number(BigInt('0x' + words(l.data)[5]))).sort((a, b) => a - b);
  if (!fees.length) {
    return { swaps: 0, pays: null, why: 'обменов не было — платит или нет, неизвестно',
             blocks: latest - from };
  }
  const median = fees[Math.floor(fees.length / 2)];
  const maxFee = fees[fees.length - 1];
  return {
    swaps: fees.length, median, maxFee, blocks: latest - from,
    // Платит, если хоть один обмен из недавних взял ненулевую комиссию.
    // Строже нельзя: у плавающей комиссии часть обменов законно идёт по нулю.
    pays: maxFee > 0,
    why: maxFee > 0 ? null : 'все недавние обмены прошли с нулевой комиссией',
  };
}

// ── сделки целиком: вход, выход и честный итог ───────────────────────────
//
// Как считают PnL Кристал и Метеора: внесённое оценивается по цене НА
// МОМЕНТ ВХОДА, полученное — по цене НА МОМЕНТ ВЫХОДА. Разница и есть итог.
// Комиссии отдельно прибавлять НЕ надо: при закрытии позиции пул отдаёт
// тело вместе с накопленными комиссиями одним движением, и в полученных
// суммах они уже сидят.
//
// Я же раньше пытался угадать цену закрытия из самих вернувшихся сумм.
// Получил «цену закрытия 1.000000», сделки по +15789% и итог +165 562 при
// обороте в тысячи. Гадать не нужно — всё лежит в цепочке.
const MODIFY_TOPIC =
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';

// Все позиции автора ЗА ВСЮ ИСТОРИЮ, одним запросом.
//
// Раньше список собирался окнами на 60 000 блоков назад. При блоке в 0.1 с
// это 1.7 часа — всё, что старше, просто исчезало. Фильтр по адресу делает
// запрос дешёвым независимо от глубины: 103 позиции за 277 мс.
// НАЧАЛО ОТРЕЗКА ЗАДАЁТСЯ СНАРУЖИ, И ЭТО НЕ ПРИДИРКА.
//
// В сети Robinhood публичный узел отдаёт журнал с нулевого блока, и один
// запрос по всей истории дёшев. В BSC узел хранит только недавние блоки, и
// запрос с нуля превращается в два десятка отказов «archive requests
// require...», каждый из которых делит отрезок пополам. У автора это заняло
// три минуты и закончилось «Load failed» в браузере телефона; позицию спас
// журнал терминала, а не цепочка. Поэтому там, где глубины нет, спрашиваем
// сразу недавнее окно.
async function readAllPositions(rpc, owner, fromBlock = 0) {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const from = Math.max(0, fromBlock < 0 ? latest + fromBlock : fromBlock);
  const logs = await getLogsSplit(rpc, {
    address: RH.positionManager,
    topics: [TRANSFER_TOPIC, null, '0x' + addrWord(owner)],
  }, from, latest);
  const seen = new Map();
  for (const l of logs) {
    const id = BigInt(l.topics[3]).toString();
    const b = Number(BigInt(l.blockNumber));
    if (!seen.has(id) || b < seen.get(id)) seen.set(id, b);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])                  // свежие первыми
    .map(([id, block]) => ({ id, block }));
}

// Открытие и закрытие позиции из событий пула.
//
// В событии ModifyLiquidity последнее слово — salt, а PositionManager кладёт
// туда номер NFT. Проверено: у позиции 480071 ровно два события, +L и −L на
// ту же величину. Так вход и выход сходятся без догадок.
async function readPositionEvents(rpc, poolId, fromBlock, ids) {
  const want = new Set(ids.map(i => BigInt(i).toString(16).padStart(64, '0')));
  const byId = new Map();
  const take = (logs) => {
    for (const l of logs) {
      const w = words(l.data);
      const salt = w[w.length - 1];
      if (!want.has(salt)) continue;
      const id = BigInt('0x' + salt).toString();
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({
        block: Number(BigInt(l.blockNumber)),
        hash: l.transactionHash,
        delta: toSigned(BigInt('0x' + w[2]), 256),
      });
    }
  };
  try {
    take(await rpc('eth_getLogs', [{
      fromBlock: '0x' + fromBlock.toString(16), toBlock: 'latest',
      address: RH.poolManager, topics: [MODIFY_TOPIC, poolId],
    }]));
  } catch (e) {
    // Оживлённый пул может не влезть в один ответ — идём окнами.
    //
    // ЗДЕСЬ СТОЯЛ break, И ОН ТЕРЯЛ ЗАКРЫТИЯ ПОЗИЦИЙ.
    //
    // 11.09.2026 в отчёте по сделкам четыре позиции получили «закрытие не
    // нашёл» — при том что в цепочке оно есть, я потом нашёл его руками.
    // Причина: на пуле MARIO узел отвечал «log query timed out» на окне в
    // пятьдесят тысяч блоков, первая же такая неудача обрывала перебор, и
    // всё, что лежало ДАЛЬШЕ, просто не читалось. Молча.
    //
    // Правильное поведение: неудачное окно уменьшить и повторить, а если и
    // это не вышло — пропустить ЕГО, но продолжить остальные, и сказать
    // вслух, сколько окон не прочиталось. «Не нашёл» и «не смог прочитать»
    // это разные ответы, и путать их на деньгах нельзя.
    const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
    let missed = 0;
    const window = async (from, to, depth) => {
      try {
        take(await rpc('eth_getLogs', [{
          fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
          address: RH.poolManager, topics: [MODIFY_TOPIC, poolId],
        }]));
      } catch (e2) {
        // Делим пополам до четырёх раз: узел обычно давится размером ответа,
        // а не самим запросом.
        if (depth >= 4 || to - from < 200) { missed++; return; }
        const mid = Math.floor((from + to) / 2);
        await window(from, mid, depth + 1);
        await window(mid + 1, to, depth + 1);
      }
    };
    for (let st = fromBlock; st <= latest; st += 50000) {
      await window(st, Math.min(latest, st + 49999), 0);
    }
    // Счётчик вешаем СВОЙСТВОМ, а не записью в карте: вызывающий перебирает
    // её ключи как номера позиций, и служебная запись стала бы «позицией».
    if (missed) byId.missed = missed;
  }
  for (const v of byId.values()) v.sort((a, b) => a.block - b.block);
  return byId;
}

// ── распределение ликвидности по цене ────────────────────────────────────
//
// То, что рисует Krystal: где именно люди поставили свои позиции.
// Считается так: в битовой карте пула отмечены тики, на которых кто-то
// открыл границу. По каждому такому тику берём liquidityNet — насколько
// меняется активная ликвидность при переходе через него. Идём от текущей
// цены наружу и складываем: получается сколько ликвидности стоит на каждом
// участке.
//
// Запросов выходит немного: несколько слов карты плюс по одному на каждый
// занятый тик. Делаем это при загрузке пула, а не в горячем пути.
// СКОЛЬКО ДЕНЕГ СТОИТ ВПЛОТНУЮ К ЦЕНЕ.
//
// У свежей монеты сводки (DexScreener, GeckoTerminal) ещё ничего не знают, и
// в списке пулов на месте оборота и ликвидности стоят прочерки. Автор
// справедливо сказал: «не видно, сколько ликвы». Но цепочка знает всё и без
// сводок — активная ликвидность лежит в самом пуле.
//
// Считаем ЧЕСТНУЮ и понятную величину: сколько монеты и стейбла стоит в
// полосе ±1% вокруг текущей цены. Это не «TVL пула» (его в V4 вообще нельзя
// назвать одним числом), а ровно то, что важно входящему: какая толщина
// рядом с ценой.
//
//   amount0 = L * (1/√P − 1/√Pb)      amount1 = L * (√P − √Pa)
async function poolDepth(rpc, poolId, sqrtPriceX96, d0, d1, stableIsFirst, bandPct = 1) {
  let L;
  try { L = BigInt(await ethCall(rpc, RH.stateView, SEL.getLiquidity + stripHex(poolId))); }
  catch (e) { return null; }
  if (!L || L === 0n) return { stable: 0, coin: 0, total: 0, empty: true };
  const P = Number(sqrtPriceX96) / Number(Q96);        // √P в единицах цены
  if (!(P > 0)) return null;
  const k = Math.sqrt(1 + bandPct / 100);
  const sqrtP = P, sqrtA = P / k, sqrtB = P * k;
  const Ln = Number(L);
  const amount0 = Ln * (1 / sqrtP - 1 / sqrtB) / Math.pow(10, d0);
  const amount1 = Ln * (sqrtP - sqrtA) / Math.pow(10, d1);
  const raw = sqrtP * sqrtP * Math.pow(10, d0 - d1);   // c1 за c0
  const stable = stableIsFirst ? amount0 : amount1;
  const coin = stableIsFirst ? amount1 : amount0;
  const coinPrice = stableIsFirst ? (raw ? 1 / raw : 0) : raw;
  return { stable, coin, total: stable + coin * coinPrice, empty: false };
}

async function readLiquidityProfile(rpc, poolId, tick, spacing, words = 3) {
  const compressed = Math.floor(tick / spacing);
  const centerWord = compressed >> 8;
  const ticks = [];
  const wordIdx = [];
  for (let w = centerWord - words; w <= centerWord + words; w++) wordIdx.push(w);
  const maps = await Promise.all(wordIdx.map(async (w) => {
    const wp = ((BigInt(w) + (1n << 256n)) % (1n << 256n))
      .toString(16).padStart(64, '0');
    // Карту занятых тиков читаем с повторами: потерять здесь один ответ —
    // значит потерять ЦЕЛОЕ СЛОВО, то есть до 256 тиков сразу. Именно так
    // график и остаётся без столбиков, когда узел ограничивает частоту.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return [w, BigInt(await ethCall(rpc, RH.stateView,
          SEL.getTickBitmap + stripHex(poolId) + wp))];
      } catch (e) {
        if (!/too many|rate|429|limit/i.test(e.message || '') || attempt === 2) return null;
        await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
      }
    }
    return null;
  }));
  for (const m of maps) {
    if (!m) continue;
    const [w, bits] = m;
    if (bits === 0n) continue;
    for (let i = 0; i < 256; i++) {
      if ((bits >> BigInt(i)) & 1n) ticks.push((w * 256 + i) * spacing);
    }
  }
  if (!ticks.length) return { ticks: [], bars: [] };
  ticks.sort((a, b) => a - b);

  // ПАЧКАМИ, А НЕ ПО ОДНОМУ.
  //
  // Занятых тиков бывает под сотню, и последовательный обход занимал
  // 62 секунды — автор увидел это в журнале. Узел спокойно держит восемь
  // запросов разом, и та же работа укладывается в пару секунд.
  const nets = new Map();
  // 20, а не 8. У автора в пуле 231 занятый тик, и восьмёрками это 5.8-7.8
  // секунды — он это чувствует как «долго грузит». Свой узел спокойно держит
  // двадцать запросов разом: те же 231 тик укладываются в полторы секунды.
  // Десять, а не двадцать: на платном узле двадцать параллельных вызовов
  // упираются в ограничение по частоте, и часть тиков выпадала из профиля.
  // Десять с повторами надёжнее и по времени не хуже.
  const BATCH = 10;
  for (let i = 0; i < ticks.length; i += BATCH) {
    const part = ticks.slice(i, i + BATCH);
    const got = await Promise.all(part.map(async (t) => {
      const tw = ((BigInt(t) + (1n << 256n)) % (1n << 256n))
        .toString(16).padStart(64, '0');
      try {
        // ПОВТОР ПРИ ОТКАЗЕ ПО ЧАСТОТЕ.
        //
        // Двадцать одновременных вызовов — это ровно то, на что платные узлы
        // отвечают «слишком часто». Один такой отказ раньше молча выбрасывал
        // тик из профиля, и на графике не хватало столбиков; при неудачном
        // стечении выпадали все, и график оставался пустым без объяснения.
        let r = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            r = await ethCall(rpc, RH.stateView,
              SEL.getTickLiquidity + stripHex(poolId) + tw);
            break;
          } catch (e) {
            if (!/too many|rate|429|limit/i.test(e.message || '') || attempt === 2) throw e;
            await new Promise(res => setTimeout(res, 400 * (attempt + 1)));
          }
        }
        const w2 = words_(r);
        // Возвращает (uint128 liquidityGross, int128 liquidityNet).
        // ВАЖНО: в ответе int128 расширен знаком до полных 32 байт, поэтому
        // разбирать надо как 256-битное со знаком. С 128 получались числа
        // порядка 10^78 — заведомая чушь, на ней и поймал.
        return [t, toSigned(BigInt('0x' + w2[1]), 256)];
      } catch (e) { return null; }
    }));
    for (const g of got) if (g) nets.set(g[0], g[1]);
  }

  // Активная ликвидность сейчас — точка отсчёта.
  let active;
  try {
    active = BigInt(await ethCall(rpc, RH.stateView,
      SEL.getLiquidity + stripHex(poolId)));
  } catch (e) { active = 0n; }

  // Вправо от цены: при переходе через тик прибавляем net.
  const bars = [];
  let cur = active;
  for (const t of ticks.filter(t => t > tick)) {
    bars.push({ from: bars.length ? bars[bars.length - 1].to : tick, to: t, liq: cur });
    cur += nets.get(t) || 0n;
  }
  // Влево: идём вниз, вычитая net пройденного тика.
  cur = active;
  const left = [];
  for (const t of ticks.filter(t => t <= tick).reverse()) {
    left.push({ from: t, to: left.length ? left[left.length - 1].from : tick, liq: cur });
    cur -= nets.get(t) || 0n;
  }
  return { ticks, bars: left.reverse().concat(bars), active };
}

const words_ = (h) => words(h);

// ── цена в МОМЕНТ ЗАКРЫТИЯ, а не сегодняшняя ────────────────────────────
//
// Итог сделки фиксируется, когда она закрыта. Тянуть в неё нынешнюю цену
// монеты неправильно: вчерашний результат от сегодняшнего курса не зависит.
//
// Архивных данных у узла нет дальше нескольких тысяч блоков, но цена и не
// нужна из архива — она однозначно выводится из того, ЧТО ВЕРНУЛОСЬ.
// Позиция описывается формулами Uniswap, и если известны обе вернувшиеся
// суммы, границы и ликвидность, то корень цены находится точно:
//
//   amount1 = L * (sqrtP - sqrtA) / 2^96   →   sqrtP = sqrtA + amount1 * 2^96 / L
//
// Работает, когда цена была ВНУТРИ диапазона. Если позиция вышла целиком в
// одну сторону, точную цену не восстановить — возвращаем границу и честно
// помечаем это как оценку.
function priceAtClose({ amount0, amount1, liquidity, tickLower, tickUpper }) {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  if (liquidity <= 0n) return null;
  if (amount1 > 0n && amount0 > 0n) {
    const sqrtP = sqrtA + (amount1 * Q96) / liquidity;
    return { sqrtP, exact: true };
  }
  if (amount1 > 0n) return { sqrtP: sqrtB, exact: false };   // ушла выше
  if (amount0 > 0n) return { sqrtP: sqrtA, exact: false };   // ушла ниже
  return null;
}

// Цена из корня: сколько currency1 за один currency0.
function priceFromSqrt(sqrtP, dec0, dec1) {
  const x = Number(sqrtP) / Number(Q96);
  return x * x * Math.pow(10, dec0 - dec1);
}

// ── права хука ───────────────────────────────────────────────────────────
//
// Права зашиты в АДРЕС хука, в младшие 14 бит. Контракт не может выполнять
// обработчик, флаг которого не стоит в адресе: PoolManager проверяет это при
// создании пула. Значит по адресу видно, что хук вправе делать, и подделать
// это нельзя.
//
// Нас интересует ровно одно: может ли хук дотянуться до ЛИКВИДНОСТИ.
// Если может — он способен либо не выпустить деньги, либо удержать часть.
// Такие пулы не берём, каким бы жирным ни был.
// Если у хука только права на обмены — он не может ни задержать вывод, ни
// забрать из позиции. Такой пул безопасен для нас.
const HOOK_FLAGS = [
  [1 << 13, 'вмешаться при создании пула', false],
  [1 << 12, 'управление после создания', false],
  [1 << 11, 'ДО ввода ликвидности', true],
  [1 << 10, 'ПОСЛЕ ввода ликвидности', true],
  [1 << 9, 'ДО вывода ликвидности', true],
  [1 << 8, 'ПОСЛЕ вывода ликвидности', true],
  [1 << 7, 'до обмена', false],
  [1 << 6, 'после обмена', false],
  [1 << 5, 'до пожертвования', false],
  [1 << 4, 'после пожертвования', false],
  [1 << 3, 'менять суммы обмена', false],
  [1 << 2, 'забирать часть обмена', false],
  [1 << 1, 'ЗАБИРАТЬ ЧАСТЬ ПРИ ВВОДЕ', true],
  [1 << 0, 'ЗАБИРАТЬ ЧАСТЬ ПРИ ВЫВОДЕ', true],
];

function hookRights(addr) {
  const v = Number(BigInt(addr) & 0x3fffn);
  const rights = [], danger = [];
  for (const [bit, name, isLiquidity] of HOOK_FLAGS) {
    if (v & bit) { rights.push(name); if (isLiquidity) danger.push(name); }
  }
  return {
    bits: v, rights, danger,
    empty: BigInt(addr) === 0n,
    // Разрешаем, только если хук НЕ имеет прав на ликвидность.
    allowed: BigInt(addr) === 0n || danger.length === 0,
    // Право «забирать часть обмена» безопасно для тела позиции, но означает,
    // что комиссию обмена может забирать себе ХУК, а не поставщик
    // ликвидности. Само по себе это не приговор — приговор выносит замер
    // реально применённой комиссии, см. poolFeeReality.
    takesSwapCut: (v & (1 << 2)) !== 0,
  };
}

// ── доступ к сети ────────────────────────────────────────────────────────
function makeRpc(url, fetchImpl) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('нет fetch');
  let id = 0;
  // Публичный узел иногда отвечает «internal server error» на совершенно
  // нормальный запрос — автор поймал это на списке позиций, и позиция с
  // деньгами не показалась. Одна повторная попытка это лечит.
  //
  // Повторяем ТОЛЬКО чтение. Отправку транзакции повторять нельзя ни при
  // каких условиях: «ошибка» могла прийти уже после того, как узел её
  // принял, и повтор означал бы второй вход теми же деньгами.
  const RETRYABLE = new Set([
    'eth_getLogs', 'eth_call', 'eth_blockNumber', 'eth_getBlockByNumber',
    'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_chainId',
    'eth_getCode', 'eth_estimateGas',
  ]);
  return async function rpc(method, params) {
    const tries = RETRYABLE.has(method) ? 3 : 1;
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await f(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        const d = await res.json();
        if (d.error) throw new Error(`${method}: ${d.error.message || 'ошибка узла'}`);
        return d.result;
      } catch (e) {
        last = e;
        // «Too Many Requests» лечится только паузой подлиннее: узел общий,
        // и долбить его чаще — делать себе же хуже.
        // «Слишком часто» лечится только паузой подлиннее: узел общий, и
        // долбить его чаще — делать себе же хуже. Внутренняя ошибка узла
        // тоже часто проходит сама, но ей нужна секунда, а не сто миллисекунд.
        const busy = /too many requests|429|rate/i.test(e.message || '');
        const sick = /internal server err+or/i.test(e.message || '');
        if (i < tries - 1) {
          await new Promise(r => setTimeout(r, (busy ? 700 : sick ? 900 : 150) * (i + 1)));
        }
      }
    }
    throw last;
  };
}

async function ethCall(rpc, to, data) {
  return rpc('eth_call', [{ to, data }, 'latest']);
}

// PoolKey по PoolId + ОБЯЗАТЕЛЬНАЯ обратная проверка.
//
// PositionManager хранит ключи по первым 25 байтам идентификатора. Поэтому
// мало получить ключ — надо пересчитать из него полный PoolId и убедиться,
// что он совпал с запрошенным. Без этого можно работать не с тем пулом.
async function loadPool(rpc, poolId, keccak256) {
  const id = stripHex(poolId).toLowerCase();
  if (id.length !== 64) throw new Error('PoolId должен быть 32 байта');
  const arg = id.slice(0, 50) + '00'.repeat(7);
  const raw = await ethCall(rpc, RH.positionManager, SEL.poolKeys + arg);
  const w = words(raw);
  if (w.length < 5) throw new Error('PositionManager не знает такого пула');
  const key = {
    currency0: '0x' + w[0].slice(24),
    currency1: '0x' + w[1].slice(24),
    fee: Number(BigInt('0x' + w[2])),
    // Тоже расширен знаком до 256 бит. Сейчас шаг всегда положительный,
    // поэтому ширина 24 давала верный ответ, но полагаться на это не стоит.
    tickSpacing: Number(toSigned(BigInt('0x' + w[3]), 256)),
    hooks: '0x' + w[4].slice(24),
  };
  const packed = w.slice(0, 5).join('');
  const recomputed = keccak256('0x' + packed).toLowerCase();
  key.poolId = '0x' + id;
  key.poolIdOk = stripHex(recomputed) === id;
  key.hooksEmpty = BigInt(key.hooks) === 0n;
  key.hook = hookRights(key.hooks);
  key.native = BigInt(key.currency0) === 0n;
  return key;
}

async function readSlot0(rpc, poolId) {
  const raw = await ethCall(rpc, RH.stateView, SEL.getSlot0 + stripHex(poolId));
  const w = words(raw);
  if (w.length < 2) throw new Error('цена не прочитана');
  const sqrtPriceX96 = BigInt('0x' + w[0]);
  // НОЛЬ — ЭТО НЕ ЦЕНА, А ОТСУТСТВИЕ ЦЕНЫ.
  //
  // У живого пула sqrtPrice не бывает нулевым: ноль отдаёт неинициализированный
  // пул, а иногда и узел на ровном месте. Раньше такой ответ проходил дальше
  // как «тик 0», и это выглядело правдоподобно, но означало цену 1:1. У пары
  // с разрядностями 6 и 18 из этого получалось «1000000000000.000000», а
  // стоимость позиции превращалась в 4e+48. Автор поймал это на экране.
  //
  // Лучше честно сказать «цена не читается», чем показать число, которому
  // нельзя верить: по этому числу принимают решение о деньгах.
  if (sqrtPriceX96 === 0n) throw new Error('пул не отдал цену (нулевой sqrtPrice)');
  return {
    sqrtPriceX96,
    tick: Number(toSigned(BigInt('0x' + w[1]), 256)),
  };
}

// Проверка узла ПЕРЕД работой.
//
// Автор платит за свой узел ради скорости, и терминал обязан ходить
// именно через него. Но подставлять чужой адрес вслепую нельзя: неверный
// узел — это неверная цена, а по неверной цене строится диапазон.
// Поэтому: сеть обязана быть 4663, контракты обязаны быть на месте,
// и заодно меряем задержку — ради неё всё и затевалось.
//
// Ключ узла живёт только в браузере автора. Терминал никуда его не
// отправляет: адрес используется по прямому назначению и всё.
async function testRpc(url, fetchImpl) {
  const t0 = Date.now();
  const rpc = makeRpc(url, fetchImpl);
  const out = { url: url.replace(/\/v2\/.*$/, '/v2/…'), ok: false };
  try {
    const id = Number(BigInt(await rpc('eth_chainId', [])));
    out.chainId = id;
    if (id !== RH.chainId) {
      out.why = `узел отвечает за сеть ${id}, а нужна ${RH.chainId}`;
      return out;
    }
    out.block = Number(BigInt(await rpc('eth_blockNumber', [])));
    // Три замера подряд: одиночный ничего не говорит.
    const lat = [];
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      await rpc('eth_blockNumber', []);
      lat.push(Date.now() - t);
    }
    lat.sort((a, b) => a - b);
    out.latencyMs = lat[1];
    out.sizes = await assertContracts(rpc);
    out.ok = true;
    out.totalMs = Date.now() - t0;
  } catch (e) {
    out.why = e.message;
  }
  return out;
}

// Сеть обязана быть той самой. Это первая проверка, до всего остального.
async function assertChain(rpc) {
  const id = Number(BigInt(await rpc('eth_chainId', [])));
  if (id !== RH.chainId) {
    throw new Error(`сеть ${id}, а нужна ${RH.chainId} (Robinhood)`);
  }
  return id;
}

// Контракты обязаны существовать. На молодой сети это не формальность.
async function assertContracts(rpc) {
  const out = {};
  for (const name of ['poolManager', 'positionManager', 'stateView', 'permit2']) {
    const code = await rpc('eth_getCode', [RH[name], 'latest']);
    out[name] = (code && code !== '0x') ? (code.length - 2) / 2 : 0;
    if (!out[name]) throw new Error(`по адресу ${name} нет кода — СТОП`);
  }
  return out;
}

// ── сборка транзакции ────────────────────────────────────────────────────
//
// Разобрана НАСТОЯЩАЯ транзакция входа автора (разобрана по цепочке) и повторена
// байт в байт. Структура:
//
//   modifyLiquidities(bytes unlockData, uint256 deadline)
//   unlockData = abi.encode(bytes actions, bytes[] params)
//   actions    = 0x02 0x0d  (MINT_POSITION, SETTLE_PAIR)
//   params[0]  = PoolKey, tickLower, tickUpper, liquidity,
//                amount0Max, amount1Max, owner, hookData
//   params[1]  = (currency0, currency1)
//
// ВАЖНОЕ НАБЛЮДЕНИЕ ИЗ ЭТАЛОНА. Krystal ставит НЕиспользуемой стороне
// огромный предел (77067364678456454583042), то есть «сколько угодно».
// Мы так делать не будем: у неиспользуемой стороны предел 0. Тогда, если
// цена войдёт в диапазон и понадобится второй токен, транзакция откажет,
// а не потратит его молча.
const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const wsigned = (v) => {
  let b = BigInt(v);
  if (b < 0n) b += 1n << 256n;
  return b.toString(16).padStart(64, '0');
};
const waddr = (a) => stripHex(a).toLowerCase().padStart(64, '0');

function encodeMintParams(key, tickLower, tickUpper, liquidity,
                          amount0Max, amount1Max, owner) {
  return (
    waddr(key.currency0) + waddr(key.currency1) +
    w(key.fee) + wsigned(key.tickSpacing) + waddr(key.hooks) +
    wsigned(tickLower) + wsigned(tickUpper) + w(liquidity) +
    w(amount0Max) + w(amount1Max) + waddr(owner) +
    // Смещение до hookData считается от начала кортежа и указывает ЗА
    // всю голову. В голове 12 слов: 11 значений и само это смещение.
    // Сначала я написал 11 — вышло 352 вместо 384, и сборка разошлась
    // с настоящей транзакцией ровно на одно слово.
    w(12 * 32) +
    w(0)                               // hookData пустой
  );
}

function encodeSettlePair(currency0, currency1) {
  return waddr(currency0) + waddr(currency1);
}

// abi.encode(bytes, bytes[]) — руками, без библиотек.
function encodeUnlockData(actionsHex, paramsHex) {
  const aBytes = actionsHex.length / 2;
  const aPadded = actionsHex.padEnd(Math.ceil(aBytes / 32) * 64, '0');
  const headA = w(64);                              // смещение actions
  const actionsBlock = w(aBytes) + aPadded;
  const offParams = 64 + 32 + aPadded.length / 2;   // после блока actions
  const headP = w(offParams);
  // массив bytes[]: длина, затем смещения, затем тела
  let arr = w(paramsHex.length);
  let bodies = '';
  let cursor = paramsHex.length * 32;
  for (const ph of paramsHex) {
    arr += w(cursor);
    const bytes = ph.length / 2;
    bodies += w(bytes) + ph.padEnd(Math.ceil(bytes / 32) * 64, '0');
    cursor += 32 + Math.ceil(bytes / 32) * 32;
  }
  return headA + headP + actionsBlock + arr + bodies;
}

// Закрытие позиции: забрать всю ликвидность и получить оба токена себе.
//
// Разобрана настоящая транзакция закрытия автора (разобрана по цепочке) и
// повторена. Заметь: NFT при этом не сгорает, остаётся пустая оболочка —
// так же ведёт себя и Krystal.
function encodeDecreaseParams(tokenId, liquidity, amount0Min, amount1Min) {
  return (
    w(tokenId) + w(liquidity) + w(amount0Min) + w(amount1Min) +
    w(5 * 32) +                        // смещение до hookData: 5 слов головы
    w(0)
  );
}

function encodeTakePair(currency0, currency1, recipient) {
  return waddr(currency0) + waddr(currency1) + waddr(recipient);
}

function buildCloseCalldata({ tokenId, liquidity, currency0, currency1,
                              amount0Min = 0, amount1Min = 0,
                              recipient = MSG_SENDER, deadline }) {
  const actions = ACTION.DECREASE_LIQUIDITY.toString(16).padStart(2, '0') +
                  ACTION.TAKE_PAIR.toString(16).padStart(2, '0');
  const p0 = encodeDecreaseParams(tokenId, liquidity, amount0Min, amount1Min);
  const p1 = encodeTakePair(currency0, currency1, recipient);
  const unlock = encodeUnlockData(actions, [p0, p1]);
  const unlockBytes = unlock.length / 2;
  return SEL.modifyLiquidities + w(64) + w(deadline) +
    w(unlockBytes) + unlock.padEnd(Math.ceil(unlockBytes / 32) * 64, '0');
}

// Сколько ликвидности в позиции. Без этого закрывать нечего.
async function readPositionLiquidity(rpc, tokenId) {
  const r = await ethCall(rpc, RH.positionManager,
    SEL.getPositionLiquidity + w(tokenId));
  return BigInt(r || '0x0');
}

// Границы позиции упакованы в одно число.
// Раскладка: верхний тик в битах 32..55, нижний в 8..31.
// Проверено на настоящей позиции: распакованные границы кратны шагу пула
// и совпадают с тем, что видно в обозревателе.
function unpackTicks(info) {
  const s24 = (v) => { const n = Number(v & 0xffffffn); return n >= 0x800000 ? n - 0x1000000 : n; };
  return { tickLower: s24((info >> 8n) & 0xffffffn),
           tickUpper: s24((info >> 32n) & 0xffffffn) };
}

// НЕСОБРАННЫЕ КОМИССИИ.
//
// Сеть не хранит их отдельной строкой. Считаются так: сколько комиссий
// накопил пул внутри твоих границ с момента, когда ты вошёл, умножить на
// твою ликвидность.
//
// ВАЖНО ПОНИМАТЬ: пока цена ВНЕ твоего диапазона, комиссии не идут вообще.
// Позиция зарабатывает только когда через неё проходят сделки.
async function readFees(rpc, poolId, tokenId, tickLower, tickUpper, keccak256) {
  const salt = w(tokenId);
  const packed = '0x' + stripHex(RH.positionManager).toLowerCase() +
                 wsigned(tickLower).slice(-6) + wsigned(tickUpper).slice(-6) + salt;
  const positionId = keccak256(packed);
  const cur = await ethCall(rpc, RH.stateView,
    SEL.getFeeGrowthInside + stripHex(poolId) +
    wsigned(tickLower) + wsigned(tickUpper));
  const mine = await ethCall(rpc, RH.stateView,
    SEL.getPositionInfo + stripHex(poolId) + stripHex(positionId));
  const cw = words(cur), mw = words(mine);
  if (cw.length < 2 || mw.length < 3) return null;
  const Q128 = 1n << 128n;
  const liquidity = BigInt('0x' + mw[0]);
  const d0 = (BigInt('0x' + cw[0]) - BigInt('0x' + mw[1])) & ((1n << 256n) - 1n);
  const d1 = (BigInt('0x' + cw[1]) - BigInt('0x' + mw[2])) & ((1n << 256n) - 1n);
  return {
    liquidity,
    fee0: (liquidity * d0) / Q128,
    fee1: (liquidity * d1) / Q128,
    positionId,
  };
}

async function readPositionPool(rpc, tokenId) {
  const r = await ethCall(rpc, RH.positionManager,
    SEL.getPoolAndPositionInfo + w(tokenId));
  const x = words(r);
  if (x.length < 6) throw new Error('позиция не прочитана');
  return {
    key: {
      currency0: '0x' + x[0].slice(24), currency1: '0x' + x[1].slice(24),
      fee: Number(BigInt('0x' + x[2])),
      tickSpacing: Number(toSigned(BigInt('0x' + x[3]), 256)),
      hooks: '0x' + x[4].slice(24),
    },
    info: BigInt('0x' + x[5]),
  };
}

// ВХОД В ПАРУ С НАТИВНОЙ МОНЕТОЙ.
//
// Нативная монета (BNB в BSC, ETH в других сетях) записывается нулевым
// адресом и живёт не как токен: её нельзя ни разрешить через Permit2, ни
// перевести с кошелька контрактом. Она уходит ЗНАЧЕНИЕМ транзакции.
//
// Отсюда два отличия от обычного входа:
//   * к транзакции добавляется value, и его берут с запасом — точную сумму
//     до вэя предсказать нельзя, цена может дрогнуть между расчётом и блоком;
//   * поэтому в конец добавляется SWEEP, который возвращает отправителю всё,
//     что не ушло в позицию. Без него запас остался бы у контракта.
//
// Получатель сдачи — address(1), то есть «тот, кто прислал транзакцию»: та же
// договорённость, что и в закрытии позиции, сверенная с настоящей
// транзакцией байт в байт.
const isNativeCurrency = (a) => /^0x0{40}$/i.test(a || '');

function encodeSweep(currency, recipient) {
  return waddr(currency) + waddr(recipient);
}

function buildMintCalldata({ key, tickLower, tickUpper, liquidity,
                             amount0Max, amount1Max, owner, deadline }) {
  const native = isNativeCurrency(key.currency0) || isNativeCurrency(key.currency1);
  const actions = ACTION.MINT_POSITION.toString(16).padStart(2, '0') +
                  ACTION.SETTLE_PAIR.toString(16).padStart(2, '0') +
                  (native ? ACTION.SWEEP.toString(16).padStart(2, '0') : '');
  const p0 = encodeMintParams(key, tickLower, tickUpper, liquidity,
                              amount0Max, amount1Max, owner);
  const p1 = encodeSettlePair(key.currency0, key.currency1);
  const params = [p0, p1];
  if (native) {
    const nat = isNativeCurrency(key.currency0) ? key.currency0 : key.currency1;
    params.push(encodeSweep(nat, MSG_SENDER));
  }
  const unlock = encodeUnlockData(actions, params);
  const unlockBytes = unlock.length / 2;
  const data = SEL.modifyLiquidities +
    w(64) + w(deadline) +
    w(unlockBytes) + unlock.padEnd(Math.ceil(unlockBytes / 32) * 64, '0');
  return data;
}

// ── разрешения ───────────────────────────────────────────────────────────
//
// Путь оплаты в V4: токен → Permit2 → PositionManager. Нужны ДВА разрешения.
//
// Первое, ERC20 → Permit2, интерфейсы обычно ставят бессрочным и на всё.
// Мы так не делаем: даём ровно ту сумму, которой собираемся торговать.
// Разница простая — при бессрочном на всё одна фишинговая подпись уводит
// весь баланс токена, при ограниченном уводит только разрешённое.
//
// Второе, Permit2 → PositionManager, имеет срок жизни. Ставим короткий.

async function readAllowances(rpc, token, owner) {
  const toErc20 = await ethCall(rpc, token,
    SEL.allowance + addrWord(owner) + addrWord(RH.permit2));
  const p2 = await ethCall(rpc, RH.permit2,
    SEL.p2allowance + addrWord(owner) + addrWord(token) +
    addrWord(RH.positionManager));
  const pw = words(p2);
  return {
    erc20ToPermit2: BigInt(toErc20 || '0x0'),
    permit2Amount: pw.length ? BigInt('0x' + pw[0].slice(24)) : 0n,   // uint160
    permit2Expiration: pw.length > 1 ? Number(BigInt('0x' + pw[1])) : 0,
    permit2Nonce: pw.length > 2 ? Number(BigInt('0x' + pw[2])) : 0,
  };
}

function buildErc20Approve(token, amount) {
  return { to: token, data: SEL.approve + addrWord(RH.permit2) + w(amount) };
}

function buildPermit2Approve(token, amount, expirationUnix) {
  const MAX160 = (1n << 160n) - 1n;
  const MAX48 = (1n << 48n) - 1n;
  if (BigInt(amount) > MAX160) throw new Error('сумма не влезает в uint160');
  if (BigInt(expirationUnix) > MAX48) throw new Error('срок не влезает в uint48');
  return {
    to: RH.permit2,
    data: SEL.p2approve + addrWord(token) + addrWord(RH.positionManager) +
          w(amount) + w(expirationUnix),
  };
}

// Что нужно сделать перед входом на заданную сумму. Возвращает список
// действий, а не выполняет их: подписывает всегда автор.
async function planApprovals(rpc, token, owner, amountNeeded, ttlSeconds, nowUnix) {
  const a = await readAllowances(rpc, token, owner);
  const need = BigInt(amountNeeded);
  const steps = [];
  if (a.erc20ToPermit2 < need) {
    steps.push({ what: 'разрешить Permit2 тратить токен',
                 tx: buildErc20Approve(token, need), amount: need.toString() });
  }
  const expired = a.permit2Expiration <= nowUnix + 60;
  if (a.permit2Amount < need || expired) {
    const exp = nowUnix + ttlSeconds;
    steps.push({ what: 'разрешить PositionManager брать через Permit2',
                 tx: buildPermit2Approve(token, need, exp),
                 amount: need.toString(), until: exp });
  }
  return { current: a, steps };
}

// Симуляция. Обязательна: дешёвый способ узнать об отказе до подписи.
async function simulate(rpc, from, to, data, value) {
  try {
    // value нужен для входа в пару с нативной монетой: без него узел
    // отвергнет вызов, и «симуляция не прошла» сказала бы неправду о сборке.
    const call = { from, to, data };
    if (value != null && value !== 0n) call.value = '0x' + BigInt(value).toString(16);
    await rpc('eth_call', [call, 'latest']);
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

const API = {
  RH, SEL, ACTION, MIN_TICK, MAX_TICK, Q96,
  getSqrtRatioAtTick, liquidityForAmount0, liquidityForAmount1,
  planRange, makeRpc, ethCall, loadPool, readSlot0, testRpc, amountsForLiquidity,
  hookRights, HOOK_FLAGS, readLiquidityProfile, readMyPositions, readHistory,
  priceAtClose, priceFromSqrt, findMint, txFlows, priceAtBlock, blockTime,
  readAllPositions, readPositionEvents, MODIFY_TOPIC, SWAP_TOPIC,
  poolFeeReality, getLogsSplit, askedToRawPct, rawToShownPct,
  poolsOfToken, INIT_TOPIC,
  assertChain, assertContracts, words, toSigned, stripHex, addrWord, hex,
  buildMintCalldata, encodeMintParams, encodeSettlePair, encodeUnlockData,
  readAllowances, buildErc20Approve, buildPermit2Approve, planApprovals, simulate,
  buildCloseCalldata, encodeDecreaseParams, encodeTakePair, encodeSweep, isNativeCurrency,
  readPositionLiquidity, readPositionPool, MSG_SENDER, unpackTicks, readFees, poolDepth,
  CHAINS, useChain,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.RHCore = API;

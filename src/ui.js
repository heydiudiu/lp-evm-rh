// Страница терминала.
//
// Устройство подчинено одному: между нажатием «ВОЙТИ» и открытием кошелька
// не должно быть ни одного ожидания сети. Поэтому:
//
//   ключ пула читается при загрузке — он не меняется;
//   разрешения проверяются при ARM, а не при входе;
//   цена держится свежей опросом раз в 250 мс;
//   симуляция запускается ПАРАЛЛЕЛЬНО с открытием кошелька и успевает
//   ответить, пока автор читает окно Rabby.
//
// Замеры на публичном узле: чтение цены 119 мс, симуляция 119 мс. Оба
// вынесены из горячего пути, остаётся около 1 мс на расчёт и сборку.

'use strict';

(() => {
  const C = window.RHCore, W = window.RHWallet;
  const $ = (id) => document.getElementById(id);
  // ВЫБОР СЕТИ. Сохраняется отдельно от всех прочих настроек и читается
  // ПЕРВЫМ: от него зависят и адреса контрактов, и ключи памяти.
  const CHAIN_KEY = 'lp-chain';
  const chainName = (() => {
    let saved = null;
    try { saved = localStorage.getItem(CHAIN_KEY); } catch (e) { }
    if (C.CHAINS[saved]) return saved;
    // Кто пришёл впервые — попадает в ту сеть, которую обещает ссылка.
    // Страница лежит по двум адресам, и открывший .../lp-bsc/ ждёт BSC,
    // а не Robinhood. Свой выбор, если он был, всегда важнее адреса.
    try {
      if (/bsc|bnb/i.test(location.pathname)) return 'bsc';
    } catch (e) { }
    return 'robinhood';
  })();
  C.useChain(chainName);

  // ПАМЯТЬ БРАУЗЕРА У РАЗНЫХ СЕТЕЙ ДОЛЖНА БЫТЬ РАЗНОЙ.
  //
  // Страницы лежат на одном домене, а localStorage делится по домену, а не по
  // папке. С общим ключом версия для BSC подхватывала настройки для
  // Robinhood: чужой адрес узла, чужой список недавних пулов, чужую ширину.
  //
  // Опаснее другое: в журнале входов лежат суммы, по которым считается итог
  // позиции, а номера позиций в разных сетях независимы и могут совпасть.
  // Общий журнал означал бы итог, посчитанный от чужого входа. Ключи заданы
  // в описании сети и МЕНЯТЬ ИХ НЕЛЬЗЯ — вместе с ключом потеряется история.
  const KEY = C.RH.storeKey;
  // Номер версии на виду. Без него не отличить обновлённую сборку от старой:
  // автор дважды присылал скрин со старой, думая, что она новая.
  const VERSION = '5.2.2';

  // Нативная монета сети записывается нулевым адресом. Нужна и на входе
  // (туда пока не пускаем), и при разборе квитанции: событий Transfer у неё
  // не бывает.
  const TRANSFER_TOPIC =
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const isNative = a => /^0x0{40}$/i.test(a || '');
  const LEDGER = C.RH.ledgerKey;       // память о входах: без неё PnL не посчитать

  const state = {
    rpc: null, rpcUrl: '', account: null,
    pool: null, slot0: null, slot0At: 0,
    amount: 2, side: 'down', intent: 'buy', width: 30, gap: 5,
    decimals: {}, pools: [], busy: false, profile: null, profileAt: 0,
  };

  // ── журнал ──────────────────────────────────────────────────────────────
  function log(msg, kind) {
    const d = document.createElement('div');
    const t = new Date().toTimeString().slice(0, 8);
    d.textContent = `${t}  ${msg}`;
    if (kind) d.className = kind;
    $('log').prepend(d);
    while ($('log').children.length > 200) $('log').lastChild.remove();
  }

  // ── память о входах ─────────────────────────────────────────────────────
  //
  // Сеть не хранит, сколько ты вложил. Она знает только состояние сейчас.
  // Поэтому момент входа записываем сами: сумму, цену и время. Без этого
  // после закрытия можно показать только «сколько вернулось», а не итог.
  const ledger = {
    all() { try { return JSON.parse(localStorage.getItem(LEDGER) || '{}'); }
            catch (e) { return {}; } },
    put(k, v) { const a = this.all(); a[k] = { ...(a[k] || {}), ...v };
                localStorage.setItem(LEDGER, JSON.stringify(a)); },
    get(k) { return this.all()[k] || null; },
  };

  const save = () => localStorage.setItem(KEY, JSON.stringify({
    rpcUrl: state.rpcUrl, amount: state.amount, side: state.side,
    width: state.width, gap: state.gap, intent: state.intent, pool: $('pool').value,
    pools: state.pools,
  }));

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      if (s.rpcUrl) { state.rpcUrl = s.rpcUrl; $('rpc').value = s.rpcUrl; }
      if (s.pool) $('pool').value = s.pool;
      if (s.amount) state.amount = s.amount;
      if (s.intent) state.intent = s.intent;
      if (s.width) state.width = s.width;
      if (s.gap) state.gap = s.gap;
      if (Array.isArray(s.pools)) state.pools = s.pools;
    } catch (e) { /* первая загрузка */ }
  }

  // ── ряды кнопок со своим значением ──────────────────────────────────────
  function chips(host, values, suffix, get, set) {
    host.innerHTML = '';
    for (const v of values) {
      const b = document.createElement('button');
      b.textContent = v + suffix;
      if (get() === v) b.classList.add('on');
      b.onclick = () => {
        // Кнопка с готовой суммой — тоже ручной ввод по смыслу.
        state.amountRaw = null; state.amountRawToken = null;
        set(v); chips(host, values, suffix, get, set); recalc(); save();
      };
      host.appendChild(b);
    }
    const own = document.createElement('input');
    own.type = 'text'; own.className = 'own'; own.placeholder = 'своё';
    if (!values.includes(get())) own.value = String(get());
    const apply = () => {
      const v = parseFloat(String(own.value).replace(',', '.'));
      if (!isFinite(v) || v <= 0) { own.style.borderColor = 'var(--bad)'; return; }
      own.style.borderColor = '';
      set(v); chips(host, values, suffix, get, set); recalc(); save();
    };
    own.onchange = apply;
    own.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } };
    host.appendChild(own);
  }

  function sideRow() {
    const host = $('r-side');
    host.innerHTML = '';
    for (const [k, t] of [['buy', 'КУПИТЬ монету за стейбл'],
                          ['sell', 'ПРОДАТЬ монету за стейбл']]) {
      const b = document.createElement('button');
      b.textContent = t;
      if (state.intent === k) b.classList.add('on');
      b.onclick = () => {
        state.intent = k; sideRow(); amtRow(); recalc(); save();
        loadBalance().catch(() => {});
      };
      host.appendChild(b);
    }
  }

  // ── узел ────────────────────────────────────────────────────────────────
  async function checkRpc() {
    const url = $('rpc').value.trim() || C.RH.publicRpc;
    $('s-rpc').textContent = 'проверяю…';
    const r = await C.testRpc(url);
    if (!r.ok) {
      $('d-rpc').className = 'dot bad';
      $('s-rpc').textContent = 'узел не годится';
      log('узел отвергнут: ' + r.why, 'bad');
      return false;
    }
    state.rpcUrl = url; state.rpc = C.makeRpc(url);
    $('d-rpc').className = 'dot on';
    $('s-rpc').textContent = `узел ${r.latencyMs} мс`;
    $('s-block').textContent = 'блок ' + r.block;
    log(`узел годен: сеть ${r.chainId}, задержка ${r.latencyMs} мс` +
        (url === C.RH.publicRpc ? ' (публичный — медленный, поставь свой)' : ''),
        url === C.RH.publicRpc ? 'warn' : 'ok');
    save();
    return true;
  }

  // ── пул ─────────────────────────────────────────────────────────────────
  async function loadPool() {
    if (!state.rpc && !(await checkRpc())) return;
    const raw = $('pool').value.trim();

    // БЕРЁМ ПОСЛЕДНЕЕ, А НЕ САМОЕ ДЛИННОЕ.
    //
    // Автор сказал дословно: «новую цашку ДОБАВИЛ». То есть в поле остался
    // старый PoolId, а адрес монеты дописан к нему. Прежний разбор искал
    // сначала 64 знака и находил старый PoolId — терминал послушно
    // перезагружал ТОТ ЖЕ пул. Со стороны это ровно «жму, а ничего не
    // происходит»: кнопка живая, панель та же.
    //
    // Что дописано последним, то человек и имел в виду.
    const found = [...raw.matchAll(/0x[0-9a-fA-F]{40,64}/g)]
      .map(x => x[0]).filter(s => s.length === 66 || s.length === 42);
    const pick = found.length ? found[found.length - 1] : null;
    let poolId = pick && pick.length === 66 ? pick : null;
    const tokenAddr = pick && pick.length === 42 ? pick : null;
    if (found.length > 1) {
      log(`в поле ${found.length} адреса — беру последний, ` +
          `он и дописан последним`, 'warn');
    }
    if (poolId) {
      log(`вижу PoolId ${poolId.slice(0, 10)}…${poolId.slice(-6)}`);
    }
    if (!poolId) {
      const t = tokenAddr ? [tokenAddr] : null;
      if (!t) { log('не вижу ни PoolId, ни адреса монеты', 'bad'); return; }
      log(`вижу адрес монеты ${t[0].slice(0, 10)}…${t[0].slice(-6)}`);
      // Отзыв на нажатие СРАЗУ, до всякой сети: иначе кнопка выглядит мёртвой.
      log('ищу пулы этой монеты…');
      $('poolinfo').innerHTML = '<div class="hint">ищу пулы монеты…</div>';
      const tSearch = performance.now();
      const list = await poolsByToken(t[0]);
      log(`сводка ответила за ${(performance.now() - tSearch).toFixed(0)} мс: ` +
          `${list.length} пул(ов)`);
      if (!list.length) {
        // ЗАПАСНОЙ ПУТЬ — САМА ЦЕПОЧКА. Сводка DexScreener может не ответить,
        // а у события Initialize обе стороны пары проиндексированы, поэтому
        // полный список пулов монеты стоит двух запросов. Оборота и глубины
        // там нет — цепочка их не хранит, — зато список честный и полный.
        log('сводка не помогла, ищу пулы прямо в цепочке…');
        $('poolinfo').innerHTML = '<div class="hint">ищу пулы в цепочке…</div>';
        try {
          const latest = Number(BigInt(await logsRpc()('eth_blockNumber', [])));
          // СНАЧАЛА СВЕЖЕЕ. Блок здесь 0.101 с, то есть сутки — это 852 тысячи
          // блоков. Новую монету вставляют через часы после запуска, поэтому
          // трёх суток хватает почти всегда, а лезть в 55 миллионов блоков на
          // приболевшем узле означает ждать минутами.
          const DAY = 852000;
          let onchain = [];
          for (const [depth, label] of [[3 * DAY, 'за трое суток'],
                                        [20 * DAY, 'за три недели'],
                                        [latest, 'по всей истории']]) {
            $('poolinfo').innerHTML =
              `<div class="hint">ищу пулы в цепочке ${label}…</div>`;
            onchain = await C.poolsOfToken(logsRpc(), t[0], latest,
                                           latest - depth, 12);
            if (onchain.length) break;
          }
          if (onchain.length) {
            log(`в цепочке нашёл ${onchain.length} пул(ов), показываю свежие ` +
                `— оборот из цепочки не виден, смотри на «платит на деле»`, 'ok');
            await showPoolChoice(onchain.slice(0, 10).map(o => ({
              poolId: o.poolId, pair: null, liq: null, vol: null, price: 0,
            })), t[0]);
            return;
          }
        } catch (e) { log('и в цепочке не нашёл: ' + e.message, 'bad'); }
        log('пулов этой монеты не нашёл', 'bad');
        $('poolinfo').innerHTML = '<div class="hint bad">пулов этой монеты не нашёл. ' +
          'Проверь адрес монеты, либо вставь PoolId напрямую.</div>';
        return;
      }
      // Выбор за автором: молча взять «самый глубокий» значит иногда
      // войти в пул, который отстаёт от рынка.
      log(`нашёл ${list.length} пул(ов) — выбери в списке справа от поля`, 'ok');
      await showPoolChoice(list, t[0]);
      return;
    }
    try {
      const key = await C.loadPool(state.rpc, poolId, window.keccak256);
      if (!key.poolIdOk) { log('PoolId не сошёлся с ключом — это НЕ тот пул', 'bad'); return; }
      // Хук разрешаем, только если у него НЕТ прав на ликвидность.
      // Такой хук может брать своё с обменов, но не может ни задержать
      // твой вывод, ни удержать часть позиции.
      if (!key.hook.allowed) {
        log('ПУЛ ЗАПРЕЩЁН: хук имеет права на ликвидность — ' +
            key.hook.danger.join(', ') + '. Он способен не выпустить деньги.', 'bad');
        return;
      }
      if (key.native) { log('одна сторона — нативный ETH, не поддерживаем', 'bad'); return; }

      // ПЛАТИТ ЛИ ПУЛ. Проверка стоит здесь, до всего остального, потому что
      // пул, который не платит комиссий, бесполезен независимо от цены,
      // глубины и ширины диапазона: остаётся только риск цены. Автор уже
      // потерял на таком сто долларов.
      // Через кэш: если пул только что выбран из списка, он уже замерен, и
      // повторный запрос к журналу — это лишние секунды ожидания на ровном месте.
      const real = await feeRealityCached(poolId,
        Number(BigInt(await logsRpc()('eth_blockNumber', []))));
      key.real = real;
      if (real.pays === false) {
        log(`ПУЛ ЗАПРЕЩЁН: не платит поставщику ликвидности. ${real.swaps} ` +
            `недавних обмена(ов), комиссия в каждом 0.000%` +
            (key.hook.takesSwapCut ? '; хук имеет право забирать часть обмена' : '') +
            '. Стоять в нём — риск цены без дохода.', 'bad');
        $('poolinfo').innerHTML =
          `<div class="kv"><span>пара</span><b>${await tokenSymbol(key.currency0)} / ` +
          `${await tokenSymbol(key.currency1)}</b></div>` +
          `<div class="kv"><span>реальная комиссия</span><b class="bad">0.000%</b></div>` +
          `<div class="hint">Замерено по ${real.swaps} обменам из журнала сети. ` +
          `Вход в такой пул закрыт: комиссий не будет, останется только риск цены. ` +
          `Ищи другой пул этой монеты — у той же пары бывает соседний, ` +
          `который платит.</div>`;
        return;
      }
      state.pool = key;
      state.decimals[key.currency0] = await tokenDecimals(key.currency0);
      state.decimals[key.currency1] = await tokenDecimals(key.currency1);
      const s0 = await tokenSymbol(key.currency0), s1 = await tokenSymbol(key.currency1);
      // Название не прочиталось — не грузим пул. По названиям определяется,
      // какая сторона стейбл, а от этого зависит СТОРОНА диапазона и то,
      // какой токен уйдёт с кошелька. Молчаливый «?» выключал это определение.
      if (s0 === '?' || s1 === '?') {
        log('не прочитались названия токенов — пул не гружу, ' +
            'по ним выбирается сторона входа', 'bad');
        return;
      }
      key.sym0 = s0; key.sym1 = s1;
      const step = (Math.pow(1.0001, key.tickSpacing) - 1) * 100;
      $('poolinfo').innerHTML =
        `<div class="kv"><span>пара</span><b>${s0} / ${s1}</b></div>` +
        `<div class="kv"><span>комиссия в ключе</span><b class="num">${
          feeText(key.fee)}</b></div>` +
        // Главная строка. В ключе может стоять флаг плавающей комиссии, и
        // тогда число из ключа не говорит вообще ничего — платят или нет,
        // видно только по совершённым обменам.
        `<div class="kv"><span>платит на деле</span><b class="num ${
          real.pays ? 'ok' : 'warn'}">${
          real.pays ? (real.median / 10000).toFixed(3) + '%'
                    : 'неизвестно'}</b></div>` +
        `<div class="hint">${real.pays
          ? `замерено по ${real.swaps} обменам за последние ${real.blocks} блоков`
          : (real.why || 'проверить нечем') + ' — входить вслепую не стоит'}</div>` +
        `<div class="kv"><span>шаг цены</span><b class="num">${step.toFixed(2)}%</b></div>` +
        `<div class="kv"><span>минимальный отступ</span><b class="num warn">${
          ((1 - Math.pow(1.0001, -key.tickSpacing)) * 100).toFixed(2)}%</b></div>` +
        `<div class="kv"><span>хук</span><b class="${key.hooksEmpty ? 'ok' : 'warn'}">${
          key.hooksEmpty ? 'нет' : 'есть, но без прав на ликвидность'}</b></div>` +
        (key.hooksEmpty ? '' :
          `<div class="hint">умеет: ${key.hook.rights.join(', ')}. ` +
          `К твоей ликвидности доступа нет — вывести сможешь всегда.</div>`);
      log(`пул ${s0}/${s1}: в ключе ${feeText(key.fee)}, на деле ${
            real.pays ? (real.median / 10000).toFixed(3) + '% по ' + real.swaps + ' обменам'
                      : 'проверить нечем'}, ` +
          `шаг ${key.tickSpacing} тиков = ${step.toFixed(2)}%`,
          real.pays ? 'ok' : 'warn');
      rememberPool(poolId, `${s0}/${s1}`);
      startPricePump();
      save();
      loadProfile();
      amtRow();
      loadBalance().catch(() => {});
      // Выпуск монеты читаем один раз на пул: из него считается капитализация.
      loadSupply().catch(() => {});
    } catch (e) { log('пул не загрузился: ' + e.message, 'bad'); }
  }

  // ── ВЫБОР ПУЛА ПО МОНЕТЕ ────────────────────────────────────────────────
  //
  // Раньше здесь молча брался самый глубокий пул. Это опасно, и автор
  // ткнул в самую суть: цена в мелком пуле ОТСТАЁТ от рынка. У GRASS на этой
  // сети 30 пулов, и крайние показывают 0.001959 против 0.002780 — разница
  // в четверть. Войти не в тот пул значит войти по вчерашней цене.
  //
  // Цену ведёт тот пул, где идёт ОБЪЁМ, а не тот, где больше лежит.
  // Поэтому сортируем по объёму и показываем всё, что нужно для выбора,
  // включая отклонение цены от ведущего пула.
  async function poolsByToken(addr) {
    try {
      // ТАЙМАУТ ОБЯЗАТЕЛЕН. Запрос идёт в чужую сводку, и с телефона он может
      // висеть сколько угодно. Автор пять минут жал «Загрузить пул», и на
      // экране не менялось ничего: ждать было нечего, но и понять это было
      // нельзя. Лучше через десять секунд честно сказать, что не дождались.
      // У КАЖДОЙ СЕТИ СВОЯ СВОДКА, И ЭТО НЕ ВКУСОВЩИНА.
      //
      // DexScreener знает сеть Robinhood, но пулы Uniswap V4 в BSC не
      // показывает вовсе: по запросу отдаёт только пары V2 и V3 с адресом в
      // 42 символа. Я сам на этом обжёгся и сказал автору, что V4 в BSC нет,
      // — а он там есть, просто сводка о нём молчит.
      //
      // Для BSC берём GeckoTerminal и фильтруем строго по площадке: у
      // PancakeSwap Infinity идентификаторы пулов тоже 32-байтные, но живут
      // они в ДРУГОМ singleton, и такой пул увёл бы транзакцию не туда.
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
      const opts = Object.assign({ headers: { accept: 'application/json' } },
                                 ctl ? { signal: ctl.signal } : {});
      let out = [];
      if (C.RH.poolSource === 'geckoterminal') {
        const r = await fetch(
          `https://api.geckoterminal.com/api/v2/networks/${C.RH.geckoNetwork}/tokens/${addr}/pools`,
          opts);
        if (timer) clearTimeout(timer);
        const d = await r.json();
        out = (d.data || [])
          .filter(x => (x.relationships?.dex?.data?.id) === C.RH.geckoDex &&
                       /^0x[0-9a-fA-F]{64}$/.test(x.attributes?.address || ''))
          .map(x => {
            const a = x.attributes;
            return {
              poolId: a.address.toLowerCase(),
              pair: (a.name || '?').replace(/\s+\d+(\.\d+)?%$/, ''),
              liq: Number(a.reserve_in_usd) || 0,
              vol: Number(a.volume_usd?.h24) || 0,
              price: Number(a.base_token_price_usd) || 0,
            };
          });
      } else {
        const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + addr, opts);
        if (timer) clearTimeout(timer);
        const d = await r.json();
        out = (d.pairs || [])
          .filter(p => p.chainId === C.RH.dexscreenerChain &&
                       /^0x[0-9a-fA-F]{64}$/.test(p.pairAddress || ''))
          .map(p => ({
            poolId: p.pairAddress.toLowerCase(),
            pair: `${p.baseToken?.symbol || '?'}/${p.quoteToken?.symbol || '?'}`,
            liq: p.liquidity?.usd || 0,
            vol: p.volume?.h24 || 0,
            price: Number(p.priceUsd) || 0,
          }));
      }
      return out.sort((a, b) => b.vol - a.vol);
    } catch (e) {
      log('список пулов не пришёл: ' + (e.name === 'AbortError'
        ? 'сводка не ответила за 8 с' : e.message), 'bad');
      return [];
    }
  }

  async function showPoolChoice(list, coinAddr) {
    const host = $('poolinfo');
    const top = list.slice(0, 8);
    host.innerHTML = `<div class="hint">нашёл ${list.length} пул(ов). ` +
      `Цену ведёт тот, где идёт объём — он первый.</div>` +
      `<div class="hint">читаю пулы…</div>`;


    // Подробности берём с цепочки: комиссию, шаг диапазона и права хука
    // подделать нельзя, а вот сводке из интернета доверять на деньгах нельзя.
    // Номер последнего блока нужен всем замерам комиссии — берём один раз.
    let latest = 0;
    try { latest = Number(BigInt(await logsRpc()('eth_blockNumber', []))); } catch (e) { }

    const tRows = performance.now();
    const rows = await Promise.all(top.map(async (p) => {
      try {
        const k = await C.loadPool(state.rpc, p.poolId, window.keccak256);
        // Названия ядро не отдаёт — берём сами, иначе не понять, есть ли в
        // паре стейбл, а без него заходить нечем.
        k.sym0 = await tokenSymbol(k.currency0);
        k.sym1 = await tokenSymbol(k.currency1);
        // ЦЕНУ БЕРЁМ ИЗ ЦЕПОЧКИ, а не из сводки в интернете.
        // Сводка сама отстаёт: по GRASS она давала 0.00278, тогда как пул
        // в тот же момент стоял на 0.0036. Мерить отставание отстающей
        // линейкой бессмысленно.
        let onchain = null, quote = null, s0raw = null;
        try {
          const s0v = await C.readSlot0(state.rpc, p.poolId);
          s0raw = s0v;                       // пригодится для глубины у цены
          const dd0 = await tokenDecimals(k.currency0);
          const dd1 = await tokenDecimals(k.currency1);
          const raw = C.priceFromSqrt(s0v.sqrtPriceX96, dd0, dd1);
          const coinIs0 = k.currency0.toLowerCase() === (coinAddr || '').toLowerCase();
          onchain = coinIs0 ? raw : (raw ? 1 / raw : 0);
          quote = coinIs0 ? k.sym1 : k.sym0;
        } catch (e) { /* цена не прочиталась */ }
        return { ...p, key: k, ok: k.poolIdOk, onchain, quote, slot0: s0raw,
                 real: { pays: null, why: 'не замерено' } };
      } catch (e) { return { ...p, key: null, ok: false }; }
    }));

    // Сравнивать цены можно только внутри одной котировки: пул к ETH и пул
    // к стейблу меряют разными линейками. Ведущим в каждой котировке считаем
    // пул с наибольшим объёмом — цену ведёт торговля, а не глубина.
    //
    // Ведущего ищем именно по обороту: цену ведёт тот, где торгуют, даже если
    // он не платит поставщику ликвидности. Это разные вопросы — «где
    // настоящая цена» и «где мне платят».
    const lead = new Map();
    for (const r of [...rows].sort((a, b) => (b.vol || 0) - (a.vol || 0))) {
      if (!r.onchain || !r.quote) continue;
      if (!lead.has(r.quote)) lead.set(r.quote, r.onchain);
    }

    const money = (v) => v == null ? '—'
                       : v >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M'
                       : v >= 1e3 ? '$' + (v / 1e3).toFixed(0) + 'k'
                       : '$' + v.toFixed(0);

    // Отрисовка вынесена в функцию: она вызывается сразу, ещё без замеров,
    // и потом заново после каждого замера.
    const render = (measuring) => {
      host.innerHTML = '<div class="hint">нашёл ' + list.length + ' пул(ов), показываю ' +
        rows.length + '. ' +
        (measuring ? 'Замеряю, платят ли они — строки обновятся сами. '
                   : 'Сначала те, что реально платят комиссию, внутри — по обороту. ') +
        'Цена — из цепочки, сравнение внутри одной котировки.</div>';
      for (const r of rows) {
        const b = document.createElement('button');
        b.style.cssText = 'width:100%;text-align:left;margin-top:6px;padding:8px 10px';
        const base = r.quote ? lead.get(r.quote) : null;
        const dev = base && r.onchain ? (r.onchain / base - 1) * 100 : 0;
        let verdict = '', cls = 'ok';
        if (!r.ok || !r.key) { verdict = 'ключ не сошёлся — не трогать'; cls = 'bad'; }
        else if (!r.key.hook.allowed) {
          verdict = 'ХУК ДЕРЖИТ ЛИКВИДНОСТЬ — вход запрещён'; cls = 'bad';
        } else if (r.key.native) { verdict = 'сторона — нативный ETH, не поддерживаем'; cls = 'warn'; }
        // Пул, который не платит, отсекаем ЖЁСТКО и до всех остальных придирок.
        // Именно такой пул стоил автору ста долларов, и выглядел он при этом
        // лучше всех: первый по обороту, стейбл в паре, хук без прав на
        // ликвидность — по старым правилам «годен».
        else if (r.real && r.real.pays === false) {
          verdict = 'НЕ ПЛАТИТ: ' + r.real.swaps + ' обмен(ов) подряд с нулевой комиссией' +
                    (r.key.hook.takesSwapCut ? ', хук забирает часть обмена' : '');
          cls = 'bad';
        } else if (!STABLE.test(r.key.sym0 || '') && !STABLE.test(r.key.sym1 || '')) {
          verdict = 'стейбла в паре нет — заходить нечем'; cls = 'warn';
        } else if (r.pending) {
          verdict = 'замеряю, платит ли…'; cls = 'dim';
        } else if (r.real && r.real.pays === null) {
          verdict = 'платит ли — неизвестно: ' + (r.real.why || 'замер не вышел'); cls = 'warn';
        } else verdict = 'годен';
        // ПУСТОЙ ПУЛ С БЕССМЫСЛЕННОЙ ЦЕНОЙ. У свежей монеты таких бывает
        // большинство: пул создан, цена стоит на краю диапазона тиков, и в
        // строке появляется «цена в цепочке 3.4e+38» и «отклонение +5.4e+41%».
        // Спорить с такой ценой не о чем — в пул просто никто не клал денег.
        // Показываем как есть, но входить не даём и отклонение не считаем.
        const junk = r.onchain != null &&
                     (!isFinite(r.onchain) || r.onchain > 1e15 || r.onchain < 1e-15);
        if (junk) { verdict = 'пул пустой: цена стоит на краю шкалы'; cls = 'bad'; }
        const step = r.key ? (Math.pow(1.0001, r.key.tickSpacing) - 1) * 100 : 0;
        const onDeal = r.real && r.real.pays ? (r.real.median / 10000).toFixed(3) + '%'
                     : r.real && r.real.pays === false ? '0.000%'
                     : r.pending ? '…' : '?';
        b.innerHTML =
          // Имя пары берём у ключа, если он прочитан: при поиске по цепочке
          // сводки нет и подставлять оттуда нечего.
          '<b>' + esc(r.key ? `${r.key.sym0}/${r.key.sym1}` : (r.pair || '?')) +
          '</b> <span class="dim num">' +
          (r.liq || r.vol
            ? 'объём ' + money(r.vol) + ' · ликв ' + money(r.liq)
            : r.depth
              ? 'в ±1% от цены ' + money(r.depth.total) +
                ' <span class="dim">(' + money(r.depth.stable) + ' стейблом)</span>'
              : 'сводка о пуле молчит — считаю глубину по цепочке…') +
          '</span>' +
          (r.key ? '<br><span class="dim num">в ключе ' + feeText(r.key.fee) + ' · ' +
                   '<span class="' + (r.real && r.real.pays ? 'ok' : 'warn') + '">на деле ' +
                   onDeal + '</span> · шаг ' + step.toFixed(2) + '% · минимальный отступ ' +
                   ((1 - Math.pow(1.0001, -r.key.tickSpacing)) * 100).toFixed(2) + '%</span>' : '') +
          (r.onchain ? '<br><span class="dim num">цена в цепочке ' + fmtPrice(r.onchain) +
                       ' ' + esc(r.quote) + '</span>' : '') +
          '<br><span class="' + cls + '">' + verdict + '</span>' +
          (!junk && Math.abs(dev) > 1 && Math.abs(dev) < 1e6
            ? '<span class="warn"> · на ' + (dev > 0 ? '+' : '') + dev.toFixed(1) +
              '% от ведущего пула в ' + esc(r.quote) + ' — расходится</span>' : '');
        // Пока не замерено, кнопку не блокируем: войти вслепую всё равно не
        // выйдет, в loadPool стоит своя проверка на оплату.
        if (cls === 'bad') b.disabled = true;
        else b.onclick = () => { $('pool').value = r.poolId; loadPool(); };
        host.appendChild(b);
      }
    };

    log(`разобрал ${rows.length} пул(ов) за ${(performance.now() - tRows).toFixed(0)} мс, ` +
        `замеряю комиссии`);

    // СПИСОК ПОКАЗЫВАЕМ СРАЗУ, ЗАМЕРЫ ДОПИСЫВАЕМ ПОТОМ.
    //
    // Раньше список ждал, пока замерятся все восемь пулов: восемь запросов к
    // журналу по очереди, и всё это время на экране висело «читаю пулы…».
    // Автор справедливо сказал, что новый пул грузится очень долго.
    rows.sort((a, b) => (b.vol || 0) - (a.vol || 0));
    for (const r of rows) r.pending = !!(latest && r.key && r.ok);
    render(true);

    if (latest) {
      // По очереди, а не Promise.all: журнал читается только через общий
      // публичный узел, и восемь одновременных запросов он встречает отказом.
      for (const r of rows) {
        if (!r.pending) continue;
        try { r.real = await feeRealityCached(r.poolId, latest); }
        catch (e) { r.real = { pays: null, why: 'узел не ответил' }; }
        // ГЛУБИНА У ЦЕНЫ. У свежей монеты сводки ещё ничего не знают, и в
        // строке стоят прочерки вместо оборота и ликвидности. Цепочка знает:
        // считаем, сколько денег стоит в полосе ±1% вокруг цены. Это честнее
        // «TVL пула», которого в V4 одним числом и не бывает.
        if (!r.liq && r.key && r.slot0) {
          try {
            const d0 = state.decimals[r.key.currency0] ?? await tokenDecimals(r.key.currency0);
            const d1 = state.decimals[r.key.currency1] ?? await tokenDecimals(r.key.currency1);
            const stFirst = STABLE.test(r.key.sym0 || '');
            r.depth = await C.poolDepth(state.rpc, r.poolId, r.slot0.sqrtPriceX96,
                                        d0, d1, stFirst, 1);
          } catch (e) { r.depth = null; }
        }
        r.pending = false;
        render(true);
      }
      // Всё замерено — расставляем по-честному: сначала платящие.
      rows.sort((a, b) => (Number(b.real && b.real.pays === true) -
                           Number(a.real && a.real.pays === true)) || ((b.vol || 0) - (a.vol || 0)));
      render(false);
    }
  }

  // Переключатель под ценой: «новый вход» и по кнопке на каждую открытую
  // позицию. Выбранная позиция рисуется на шкале вместо планируемого входа.
  function drawWatchBar() {
    const host = $('watchbar');
    if (!host) return;
    host.innerHTML = '';
    if (!openList.length) return;
    const mk = (label, active, on) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:4px 8px;font-size:11px';
      if (active) b.className = 'on';
      b.onclick = on;
      host.appendChild(b);
    };
    mk('новый вход', !watching, () => { watching = null; drawWatchBar(); recalc(); });
    for (const o of openList) {
      mk(`${esc(o.pair)} #${o.id}`, watching && watching.id === o.id, async () => {
        watching = o;
        drawWatchBar();
        // Пул позиции может отличаться от загруженного — тогда и цена, и
        // шкала были бы не от той пары. Подгружаем нужный.
        if (!state.pool || state.pool.poolId !== o.poolId) {
          $('pool').value = o.poolId;
          await loadPool();
          watching = o;            // loadPool мог перерисовать панель
          drawWatchBar();
        }
        recalc();
      });
    }
  }

  // РАЗРЯДНОСТЬ НЕ УГАДЫВАЕМ. Раньше при отказе узла возвращалось 18, и это
  // напрямую превращалось в деньги: у USDG разрядность 6, и «2 USDG»
  // становились 2·10^18, то есть заявкой на два триллиона. Лучше отказать
  // загрузку пула, чем подписывать цифру, которую никто не проверял.
  const decCache = new Map();
  async function tokenDecimals(a) {
    if (decCache.has(a)) return decCache.get(a);
    const d = Number(BigInt(await C.ethCall(state.rpc, a, C.SEL.decimals)));
    if (!Number.isInteger(d) || d < 0 || d > 36) throw new Error('странная разрядность токена');
    decCache.set(a, d);
    return d;
  }

  async function tokenSymbol(a) {
    // Нулевой адрес — это нативная монета сети, у неё нет контракта и
    // спрашивать symbol() не у кого. Без этого в списке пулов стоял «?».
    if (isNative(a)) return C.RH.nativeSymbol;
    try {
      const r = await C.ethCall(state.rpc, a, C.SEL.symbol);
      const b = r.slice(2);
      const len = parseInt(b.slice(64, 128), 16);
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(parseInt(b.substr(128 + i * 2, 2), 16));
      return s || '?';
    } catch (e) { return '?'; }
  }

  // ── цена держится свежей ────────────────────────────────────────────────
  let pump = null;
  function startPricePump() {
    if (pump) clearInterval(pump);
    const tick = async () => {
      if (!state.pool || !state.rpc) return;
      try {
        const s = await C.readSlot0(state.rpc, state.pool.poolId);
        state.slot0 = s; state.slot0At = Date.now();
        $('d-price').className = 'dot on';
        $('s-price').textContent = 'цена живая';
        showPrice();
        recalc();
      } catch (e) {
        $('d-price').className = 'dot bad';
        $('s-price').textContent = 'цена не читается';
      }
    };
    tick();
    pump = setInterval(tick, 250);
  }

  // Сырая цена пула: сколько currency1 за один currency0.
  function rawPrice(tick) {
    const d0 = state.decimals[state.pool.currency0] ?? 18;
    const d1 = state.decimals[state.pool.currency1] ?? 18;
    return Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
  }

  // Цена ДЛЯ ЧЕЛОВЕКА: всегда «сколько стейбла за одну монету».
  //
  // Сырая цена зависит от того, каким по счёту стоит стейбл. В паре
  // USDG/TAOBAO она читалась как «1667 TAOBAO за 1 USDG» — так никто не
  // думает и на графике так не смотрят. Переворачиваем, когда стейбл
  // оказался первым.
  function priceOf(tick) {
    const raw = rawPrice(tick);
    return stableSide() === 0 ? (raw ? 1 / raw : 0) : raw;
  }

  // Названия для подписи: монета и стейбл, а не currency0/currency1.
  function names() {
    const st = stableSide();
    if (st === 0) return { coin: state.pool.sym1, stable: state.pool.sym0 };
    return { coin: state.pool.sym0, stable: state.pool.sym1 };
  }

  // ── ЦЕНА ИЛИ КАПИТАЛИЗАЦИЯ ──────────────────────────────────────────────
  //
  // Просьба автора: ставить границы и читать диапазон не по цене монеты, а по
  // капитализации. У мемкоина цена вида 0.000359391 не измеряется на глаз, а
  // «капа 1.8 млн» понятна сразу.
  //
  // Математика при этом НЕ МЕНЯЕТСЯ. Капитализация — это цена, умноженная на
  // выпуск, а выпуск у таких монет постоянный. Значит проценты ширины и
  // отступа в обоих измерениях одинаковы до последнего знака, и переключатель
  // трогает только показ. Тики, ликвидность и сборка транзакции — те же.
  //
  // ЧЕСТНАЯ ОГОВОРКА: это капа ПО ПОЛНОМУ ВЫПУСКУ (FDV). Если часть монет
  // сожжена или заморожена, настоящая рыночная капитализация меньше. Врать
  // тут нельзя, поэтому так и подписано.
  let unit = 'price';                       // 'price' | 'cap'
  try { const u = localStorage.getItem(KEY + '-unit'); if (u === 'cap') unit = 'cap'; }
  catch (e) { }

  // Выпуск монеты кэшируем по адресу: в таблице позиций монеты РАЗНЫЕ, и
  // считать капу чужой позиции по выпуску загруженного пула нельзя — это
  // был бы уверенно показанный неверный миллион.
  const supplyCache = new Map();
  async function supplyOf(token) {
    if (!token) return null;
    const k = token.toLowerCase();
    if (supplyCache.has(k)) return supplyCache.get(k);
    let n = null;
    try {
      const raw = BigInt(await C.ethCall(state.rpc, token, '0x18160ddd'));
      const d = state.decimals[token] ?? await tokenDecimals(token);
      const v = Number(raw) / Math.pow(10, d);
      n = v > 0 ? v : null;
    } catch (e) { n = null; }
    supplyCache.set(k, n);
    return n;
  }

  async function loadSupply() {
    state.supply = null;
    if (!state.pool) return;
    const st = stableSide();
    if (st === null) return;
    const coin = st === 1 ? state.pool.currency0 : state.pool.currency1;
    state.supply = await supplyOf(coin);
    drawUnits();
  }

  const capOf = (price) => state.supply ? price * state.supply : null;
  const fmtCap = (v) => v == null ? '—'
    : v >= 1e9 ? (v / 1e9).toFixed(2) + ' млрд'
    : v >= 1e6 ? (v / 1e6).toFixed(2) + ' млн'
    : v >= 1e3 ? (v / 1e3).toFixed(1) + ' тыс'
    : v.toFixed(2);

  function drawUnits() {
    const host = $('unitbar');
    if (!host) return;
    host.innerHTML = '';
    const mk = (name, label, on, disabled, title) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:3px 10px;font-size:11px;margin:0';
      if (on) b.className = 'go';
      if (disabled) { b.disabled = true; b.style.opacity = '.45'; }
      if (title) b.title = title;
      b.onclick = () => {
        if (disabled) return;
        unit = name;
        try { localStorage.setItem(KEY + '-unit', name); } catch (e) { }
        drawUnits(); showPrice(); recalc();
      };
      host.appendChild(b);
    };
    mk('price', 'цена', unit === 'price', false, 'показывать цену монеты');
    mk('cap', 'капитализация', unit === 'cap', !state.supply,
       state.supply ? 'показывать капитализацию по полному выпуску'
                    : 'выпуск монеты не прочитался — капу показать не из чего');
  }

  function showPrice() {
    if (!state.slot0) return;
    const p = priceOf(state.slot0.tick);
    const n = names();
    if (unit === 'cap' && state.supply) {
      $('price').textContent = fmtCap(capOf(p));
      $('pricesub').textContent =
        `капитализация в ${esc(n.stable)} по полному выпуску · ` +
        `цена ${p < 0.01 ? p.toPrecision(6) : p.toFixed(6)} · тик ${state.slot0.tick}`;
    } else {
      $('price').textContent = p < 0.01 ? p.toPrecision(6) : p.toFixed(6);
      $('pricesub').textContent =
        `${esc(n.stable)} за 1 ${esc(n.coin)} · тик ${state.slot0.tick}`;
    }
  }

  // Распределение ликвидности: где именно стоят чужие позиции.
  // Читается из контракта при загрузке пула — это десятки запросов,
  // в горячий путь входа они не попадают.
  async function loadProfile() {
    if (!state.pool || !state.slot0) return;
    try {
      const t0 = performance.now();
      const pr = await C.readLiquidityProfile(
        state.rpc, state.pool.poolId, state.slot0.tick, state.pool.tickSpacing, 2);
      state.profile = pr; state.profileAt = Date.now();
      log(`ликвидность прочитана: ${pr.ticks.length} занятых тиков ` +
          `за ${(performance.now() - t0).toFixed(0)} мс`);
      // ПУСТОЙ ПРОФИЛЬ НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ КАК ПУСТОЙ ГРАФИК.
      //
      // Автор прислал скрин без синих столбиков и спросил, где они. Данные
      // при этом были: 171 полоса. Молчаливая пустота на графике неотличима
      // от «в пуле никого нет», поэтому теперь так и пишем.
      if (!pr.ticks.length) {
        log('чужой ликвидности рядом с ценой не нашлось — столбиков не будет', 'warn');
      }
      recalc();
    } catch (e) {
      state.profile = null;
      log('распределение не прочиталось: ' + e.message +
          ' — столбиков не будет, нажми «Загрузить пул» ещё раз', 'warn');
    }
  }

  // ── полоса диапазона ────────────────────────────────────────────────────
  //
  // То же, что показывает Krystal: где сейчас цена и куда встанет позиция.
  // Рисуем по цене, а не по тикам, в тех же единицах, что подписи.
  // Насколько шире диапазона показывать. 0.55 — прежнее поведение, оно и
  // остаётся стартовым, чтобы у привыкшего глаза ничего не поехало.
  const ZOOMS = [0.1, 0.25, 0.55, 1.2, 3, 8, 20];
  let zoomIdx = 2;

  function drawChart(p) {
    const cv = $('chart');
    if (!cv || !state.slot0 || !state.pool) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 150;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const now = priceOf(state.slot0.tick);
    let lo = p ? Math.min(priceOf(p.tickLower), priceOf(p.tickUpper)) : now * 0.8;
    let hi = p ? Math.max(priceOf(p.tickLower), priceOf(p.tickUpper)) : now * 1.2;
    // Поле зрения: диапазон плюс запас, и цена обязательно внутри.
    // Поле зрения ЗАМЕТНО шире диапазона: автор просил видеть, что
    // творится вокруг, а не только внутри своей полосы.
    // ПОЛЕ ЗРЕНИЯ РЕГУЛИРУЕТСЯ. Раньше отступ по краям был жёстко 0.55 от
    // ширины диапазона, и что стоит заметно выше или ниже, увидеть было
    // нельзя. Теперь это множитель, а «−» и «+» его меняют.
    const span = Math.max(hi, now) - Math.min(lo, now);
    const padF = ZOOMS[zoomIdx];
    const left = Math.max(1e-18, Math.min(lo, now) - span * padF);
    const right = Math.max(hi, now) + span * padF;
    const X = (v) => (v - left) / (right - left) * w;

    // РАСПРЕДЕЛЕНИЕ ЛИКВИДНОСТИ — где стоят чужие позиции.
    const pr = state.profile;
    // Подпись под графиком говорит правду о том, есть ли что рисовать.
    const note = $('liqnote');
    if (note) {
      note.textContent = !pr
        ? 'ликвидность пула ещё не прочитана — нажми «Загрузить пул»'
        : (!pr.bars || !pr.bars.length)
          ? 'чужой ликвидности рядом с ценой не нашлось'
          : 'Столбиками — где стоит чужая ликвидность. Подписи снизу — отклонение от текущей цены.';
    }
    if (pr && pr.bars && pr.bars.length) {
      let mx = 0n;
      for (const b of pr.bars) if (b.liq > mx) mx = b.liq;
      if (mx > 0n) {
        for (const b of pr.bars) {
          const pa = priceOf(b.from), pb = priceOf(b.to);
          const xa = X(Math.min(pa, pb)), xb = X(Math.max(pa, pb));
          if (xb < 0 || xa > w) continue;
          const k = Number(b.liq * 1000n / mx) / 1000;      // доля от максимума
          const hh = Math.max(2, k * (h - 34));
          // Чем плотнее ликвидность, тем ярче и насыщеннее столбик —
          // «где сколько стоит» видно по цвету, а не только по высоте.
          const a = 0.16 + k * 0.5;
          const gr = g.createLinearGradient(0, h - 14 - hh, 0, h - 14);
          gr.addColorStop(0, `rgba(${120 + k * 47},${205 + k * 20},${175 + k * 17},${a})`);
          gr.addColorStop(1, `rgba(${33 + k * 40},${58 + k * 50},${48 + k * 40},${a * 0.6})`);
          g.fillStyle = gr;
          const x0 = Math.max(0, xa), x1 = Math.min(w, xb);
          g.fillRect(x0, h - 14 - hh, Math.max(1, x1 - x0 - 1), hh);
          g.strokeStyle = `rgba(120,190,240,${0.3 + k * 0.5})`;
          g.lineWidth = 1.5;
          g.beginPath(); g.moveTo(x0, h - 14 - hh);
          g.lineTo(x1 - 1, h - 14 - hh); g.stroke();
        }
      }
    }

    // ПОДПИСИ ЦЕН по всей ширине, чтобы можно было прикинуть уровень.
    g.font = '10px ui-monospace,Menlo,monospace';
    g.textAlign = 'center';
    for (let i = 0; i <= 6; i++) {
      const x = w * i / 6;
      const v = left + (right - left) * i / 6;
      g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h - 12); g.stroke();
      g.fillStyle = '#788291';
      const rel = (v / now - 1) * 100;
      g.fillText((rel >= 0 ? '+' : '') + rel.toFixed(0) + '%',
                 Math.min(w - 14, Math.max(14, x)), h - 2);
    }

    // полоса позиции
    if (p) {
      const x0 = X(lo), x1 = X(hi);
      const grad = g.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, 'rgba(38,208,124,.06)');
      grad.addColorStop(.5, 'rgba(38,208,124,.20)');
      grad.addColorStop(1, 'rgba(38,208,124,.06)');
      g.fillStyle = grad;
      g.fillRect(x0, 8, Math.max(2, x1 - x0), h - 22);
      g.strokeStyle = '#81d8ad'; g.lineWidth = 2;
      for (const x of [x0, x1]) {
        g.beginPath(); g.moveTo(x, 6); g.lineTo(x, h - 14); g.stroke();
      }
      g.fillStyle = 'rgba(38,208,124,.9)';
      g.font = '10px ui-monospace,Menlo,monospace';
      g.textAlign = 'left';
      g.fillText('моя позиция', Math.max(2, x0 + 4), 16);
    }

    // текущая цена
    const xn = X(now);
    g.strokeStyle = '#e2b87b'; g.lineWidth = 2;
    g.setLineDash([4, 3]);
    g.beginPath(); g.moveTo(xn, 4); g.lineTo(xn, h - 10); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#e2b87b';
    g.beginPath(); g.moveTo(xn, 4); g.lineTo(xn - 5, -3); g.lineTo(xn + 5, -3);
    g.closePath(); g.fill();

    // Шкала под графиком — в тех же единицах, что и всё остальное.
    if (unit === 'cap' && state.supply) {
      $('c-lo').textContent = fmtCap(capOf(left));
      $('c-hi').textContent = fmtCap(capOf(right));
      $('c-now').textContent = 'капа ' + fmtCap(capOf(now));
    } else {
      $('c-lo').textContent = fmtPrice(left);
      $('c-hi').textContent = fmtPrice(right);
      $('c-now').textContent = 'цена ' + fmtPrice(now);
    }

    // ГЛАВНОЕ ЧИСЛО, а не картинка: сколько цене ещё идти до диапазона.
    // Пока она снаружи, позиция не работает и комиссий не приносит.
    if (p) {
      const inside = now >= lo && now <= hi;
      const near = now < lo ? lo : hi;             // ближняя граница
      const away = (near / now - 1) * 100;
      $('c-gap').innerHTML = inside
        ? '<span class="ok">цена ВНУТРИ — позиция работает</span>'
        : `до диапазона <b class="num warn">${Math.abs(away).toFixed(2)}%</b> ` +
          `<span class="dim">${away > 0 ? 'вверх' : 'вниз'}</span>`;
    } else {
      $('c-gap').textContent = '';
    }
  }

  // ── расчёт диапазона ────────────────────────────────────────────────────
  // Цена как на графике: без экспоненты, с достаточным числом знаков,
  // чтобы уровень можно было отложить у себя в терминале.
  function fmtPrice(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v >= 1) return v.toFixed(6);
    const mag = Math.floor(Math.log10(v));
    return v.toFixed(Math.min(18, Math.max(6, -mag + 4)));
  }

  function recalc() {
    if (!state.pool || !state.slot0) return null;
    try {
      const r = resolveSide();
      state.side = r.side;
      const below = goesBelow(r.side);
      const p = C.planRange({
        tick: state.slot0.tick, tickSpacing: state.pool.tickSpacing,
        widthPct: askedToRaw(state.width, below),
        gapPct: askedToRaw(state.gap, below),
        side: r.side,
      });
      // Показываем ЯВНО, какой токен уйдёт с кошелька. Именно эту строку
      // надо сверять с окном Rabby.
      const depSym = r.token.toLowerCase() === (state.pool.currency0 || '').toLowerCase()
        ? state.pool.sym0 : state.pool.sym1;
      $('v-dep').textContent = `${state.amount} ${depSym}`;
      // При перевороте цены нижняя граница становится верхней.
      const a = priceOf(p.tickLower), b = priceOf(p.tickUpper);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (unit === 'cap' && state.supply) {
        $('l-lo').textContent = 'Min капа';
        $('l-hi').textContent = 'Max капа';
        $('v-lo').textContent = fmtCap(capOf(lo));
        $('v-hi').textContent = fmtCap(capOf(hi));
      } else {
        $('l-lo').textContent = 'Min Price';
        $('l-hi').textContent = 'Max Price';
        $('v-lo').textContent = fmtPrice(lo);
        $('v-hi').textContent = fmtPrice(hi);
      }
      // Проценты показываем В ТОЙ ЖЕ ЦЕНЕ, что и Min/Max выше и график ниже.
      const gapShown = rawToShown(p.gapReal);
      const widthShown = rawToShown(p.widthReal);
      $('v-gap').textContent = gapShown.toFixed(2) + '%';
      $('v-width').textContent = widthShown.toFixed(2) + '%';
      $('v-side').innerHTML = p.oneSided
        ? '<span class="ok">да</span>' : '<span class="bad">НЕТ</span>';
      const asked = below ? -state.gap : state.gap;
      // Если следим за открытой позицией и загружен ЕЁ пул — рисуем её
      // границы, а не будущий вход. Панель «что получится» слева при этом
      // по-прежнему про новый вход: это разные вопросы.
      const w = watching && state.pool && state.pool.poolId === watching.poolId
        ? { tickLower: watching.tickLower, tickUpper: watching.tickUpper } : null;
      drawChart(w || p);
      $('rangeinfo').innerHTML = Math.abs(gapShown - asked) > 1
        ? `<div class="hint warn">просил ${asked}%, шаг пула позволяет только ` +
          `${gapShown.toFixed(2)}% — это ограничение пула, не ошибка</div>` : '';
      return p;
    } catch (e) {
      drawChart(null);
      $('rangeinfo').innerHTML = `<div class="hint bad">${e.message}</div>`;
      return null;
    }
  }

  // ── деньги ──────────────────────────────────────────────────────────────
  // КАКОЙ ТОКЕН ВНОСИТСЯ.
  //
  // Здесь была моя ошибка, из-за которой терминал чуть не внёс мемкоин
  // вместо стейбла. Порядок токенов в пуле задаётся их адресами, а не
  // смыслом: в паре UNICORN/USDG стейбл оказался вторым, а в USDG/TAOBAO —
  // ПЕРВЫМ. Я же считал, что «вниз» всегда значит «вторым токеном».
  //
  // Правило без исключений:
  //   диапазон НИЖЕ цены держит currency1;
  //   диапазон ВЫШЕ цены держит currency0.
  //
  // Поэтому сторону выбирает не человек, а расположение стейбла в паре.
  // Комиссия из ключа пула. Значение от 0x800000 — это НЕ проценты, а флаг
  // плавающей комиссии; делить его на 10000 давало «838.86%». И три знака
  // после запятой обязательны: 0.003% и 0.000% на глаз различаются только так.
  // ЭКРАНИРОВАНИЕ ВСЕГО, ЧТО ПРИШЛО ИЗ СЕТИ.
  //
  // symbol() токена возвращает произвольную строку, которую пишет автор
  // токена, а сводка DexScreener — чужой ответ из интернета. Обе шли прямо
  // в innerHTML. Токен с именем вида «<img src=x onerror=…>» выполнял бы свой
  // скрипт на странице, где лежит доступ к кошельку, — и достаточно было
  // просто посмотреть список пулов, ничего не выбирая. На цепочке, полной
  // мемкоинов со случайными именами, это не теория.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function feeText(fee) {
    if (fee >= 0x800000) return 'плавающая';
    return (fee / 10000).toFixed(3) + '%';
  }

  // Замер комиссии по пулу не меняется за минуту, а стоит запроса к журналу.
  // Без кэша повторный выбор той же монеты снова ждал бы все замеры заново.
  // ЗА ЧЕМ СЛЕДИТ ВЕРХНЯЯ ШКАЛА.
  //
  // Раньше она всегда рисовала БУДУЩИЙ вход из формы слева. Когда позиции уже
  // открыты, это сбивает с толку: на шкале одно, в таблице другое, а если
  // загруженный пул вообще не тот, в котором стоит позиция, — шкала не имеет
  // к ней отношения. Теперь можно выбрать, за чем смотреть.
  let watching = null;          // {id, pair, poolId, tickLower, tickUpper}
  let openList = [];            // открытые позиции для переключателя

  const feeCache = new Map();
  async function feeRealityCached(poolId, latest) {
    if (feeCache.has(poolId)) return feeCache.get(poolId);
    const r = await C.poolFeeReality(logsRpc(), poolId, latest);
    feeCache.set(poolId, r);
    return r;
  }

  // ДЕНЕЖНАЯ СТОРОНА ПАРЫ.
  //
  // На Robinhood это всегда был стейбл. На BSC автор фармит и в USDT, и в
  // BNB, поэтому BNB здесь тоже считается денежной стороной: именно ею
  // измеряется цена монеты и ею же заходят в диапазон сверху вниз.
  // Имя STABLE оставлено, чтобы правки из того терминала переносились сюда.
  // ЗАПИСЬ ВХОДА СТАРОГО ОБРАЗЦА.
  //
  // До 08.09.2026 в журнал попадало КОЛИЧЕСТВО внесённого токена, а не его
  // стоимость в стейбле. Для входа стейблом это одно и то же, а для входа
  // монетой — нет: 434198 MADE сравнивались со 159.68 USDG, и выходил
  // «убыток −99.96%» на сделке, которая ничего подобного не значила.
  //
  // Новые записи помечены полем depIsStable. У старых его нет, и если число
  // входа несопоставимо с тем, что вернулось, доверять ему нельзя: честнее
  // сказать «не считаю», чем показать выдуманный минус.
  function entryUsable(rec, gotValue) {
    if (!rec || rec.amountIn == null) return false;
    if (rec.depIsStable !== undefined) return true;      // новая запись
    if (!(gotValue > 0)) return true;
    return rec.amountIn < gotValue * 50;                 // старая, но правдоподобная
  }

  const STABLE = /^(usdt|usdc|busd|fdusd|usd1|dai|usde|frax|tusd|usdg|bnb|wbnb)$/i;

  // Символ денежной стороны текущего пула. До загрузки пула — USDT как
  // самый частый случай на этой сети; это только подпись, не расчёт.
  function quoteSym() {
    const st = stableSide();
    if (st === null || !state.pool) return 'USDT';
    return st === 1 ? state.pool.sym1 : state.pool.sym0;
  }

  function stableSide() {
    if (!state.pool) return null;
    if (STABLE.test(state.pool.sym1 || '')) return 1;
    if (STABLE.test(state.pool.sym0 || '')) return 0;
    return null;                                  // стейбла в паре нет
  }

  // ── ПРОЦЕНТЫ ТОЖЕ НАДО ПЕРЕВОРАЧИВАТЬ ───────────────────────────────────
  //
  // Границы диапазона я когда-то уже чинил: цену переворачивал, а границы
  // оставлял сырыми, и в таблице выходило «Min 2610» при цене 0.0004.
  // Проценты остались непочиненными, и это всплыло на USDG/ROBINCAT.
  //
  // Тик считает currency1 за currency0. Когда стейбл стоит ПЕРВЫМ, показанная
  // цена — перевёрнутая, и «вниз» в ней означает «вверх» в тиках. Автор
  // просил ширину 50%, планировщик честно отложил +50% в сырой цене, а на
  // графике это оказалось всего −34.7%: 1/1.5314 = 0.653. Он померил по
  // свечам −32% и справедливо спросил, где обещанные пятьдесят.
  //
  // Поэтому: ввод переводим из показанной цены в сырую, а результат — обратно.
  const priceInverted = () => stableSide() === 0;

  // Процент, который ввёл автор (в ТОЙ цене, что он видит) → процент для
  // планировщика (в сырой цене тиков). below — диапазон ниже показанной цены.
  // Сама арифметика живёт в ядре — там до неё дотягиваются проверки.
  const askedToRaw = (pct, below) => C.askedToRawPct(pct, below, priceInverted());
  const rawToShown = (rawPct) => C.rawToShownPct(rawPct, priceInverted());

  // Диапазон уходит ВНИЗ по показанной цене? В сырых тиках сторона может быть
  // противоположной — именно из-за этого расхождения и вышла ошибка.
  const goesBelow = (rawSide) =>
    rawSide === 'down' ? !priceInverted() : priceInverted();

  // Что человек хочет: купить монету за стейбл или продать монету за стейбл.
  // Из этого однозначно следует сторона диапазона.
  function resolveSide() {
    const st = stableSide();
    if (st === null) {
      // Пара без стейбла — работаем по прямому выбору стороны.
      return { side: state.side, token: state.side === 'down'
        ? state.pool.currency1 : state.pool.currency0, known: false };
    }
    if (state.intent === 'buy') {
      // Вносим стейбл.
      return { side: st === 1 ? 'down' : 'up',
               token: st === 1 ? state.pool.currency1 : state.pool.currency0,
               known: true };
    }
    // Вносим монету, чтобы продать её выше.
    return { side: st === 1 ? 'up' : 'down',
             token: st === 1 ? state.pool.currency0 : state.pool.currency1,
             known: true };
  }

  function quoteToken() {
    return resolveSide().token;
  }

  function amountRaw() {
    const t = quoteToken();
    // Если сумма пришла долей баланса, у нас есть точное значение в
    // минимальных единицах — берём его, а не пересчитываем из дробного числа.
    if (state.amountRaw != null && state.amountRawToken &&
        state.amountRawToken.toLowerCase() === t.toLowerCase()) {
      return state.amountRaw;
    }
    const d = state.decimals[t] ?? 18;
    return BigInt(Math.round(state.amount * Math.pow(10, Math.min(d, 15)))) *
           (10n ** BigInt(Math.max(0, d - 15)));
  }

  async function arm() {
    if (!state.pool || !state.account) { log('нужны пул и кошелёк', 'bad'); return; }
    const token = quoteToken();
    const need = amountRaw();
    const now = Math.floor(Date.now() / 1000);
    const plan = await C.planApprovals(state.rpc, token, state.account, need, 1800, now);
    if (!plan.steps.length) { log('разрешений уже хватает, можно входить', 'ok'); return; }
    for (const s of plan.steps) {
      log('прошу подпись: ' + s.what + ' на ' + state.amount);
      try {
        const h = await W.send({ from: state.account, to: s.tx.to, data: s.tx.data });
        log('отправлено: ' + h, 'ok');
      } catch (e) { log('отказ: ' + e.message, 'bad'); return; }
    }
  }

  async function open() {
    if (state.busy) return;
    const p = recalc();
    if (!p) { log('диапазон не посчитан', 'bad'); return; }
    if (!state.account) { log('кошелёк не подключён', 'bad'); return; }
    if (!p.oneSided) { log('позиция не односторонняя — не отправляю', 'bad'); return; }
    const age = Date.now() - state.slot0At;
    if (age > 3000) { log(`цене ${age} мс — жду свежую`, 'warn'); return; }

    // ПРОВЕРКА БАЛАНСА ДО КОШЕЛЬКА.
    //
    // Симуляция ловит нехватку токена, но она идёт параллельно и её ответ
    // приходит уже при открытом окне подписи. Дешевле проверить заранее:
    // один запрос, зато не откроется окно с заведомо провальной сделкой.
    const dep = resolveSide();
    // Снимок того, на чём строился план: всё, что после await, обязано
    // относиться к тому же пулу и той же сумме. Иначе в calldata попадут
    // тики одного пула и ключ другого.
    // ПАРА С НАТИВНОЙ МОНЕТОЙ.
    //
    // Нативную сторону нельзя провести через Permit2: она уходит ЗНАЧЕНИЕМ
    // транзакции, а сдачу возвращает действие SWEEP, добавленное в ядре.
    // Вносим ровно ту сумму, что в поле: позиция односторонняя, больше
    // предела contract взять не может, а неиспользованное вернётся само.
    const depNative = isNative(dep.token);
    if (depNative) {
      // Путь собран и проверен симуляцией на живом пуле, но НИ РАЗУ не
      // проходил живыми деньгами. Об этом надо сказать до окна кошелька,
      // а не после.
      log(`вход нативным ${C.RH.nativeSymbol}: он уходит значением транзакции, ` +
          'сдачу вернёт SWEEP. Этот путь ещё не проверялся живыми деньгами — ' +
          'первый раз заходи маленькой суммой.', 'warn');
    }

    const snapPool = state.pool, snapAmount = state.amount;
    try {
      // У нативной монеты нет контракта и нет balanceOf — баланс спрашивается
      // у самой сети. И запас на газ нужен именно здесь: если внести весь
      // BNB до копейки, платить за транзакцию будет нечем.
      const bal = depNative
        ? BigInt(await state.rpc('eth_getBalance', [state.account, 'latest']))
        : BigInt(await C.ethCall(state.rpc, dep.token,
            C.SEL.balanceOf + C.addrWord(state.account)));
      const need = amountRaw();
      const GAS_RESERVE = 3n * 10n ** 15n;              // 0.003 нативной монеты
      if (depNative && bal < need + GAS_RESERVE) {
        log(`на кошельке ${(Number(bal) / 1e18).toFixed(5)} ${C.RH.nativeSymbol}, ` +
            `а нужно ${state.amount} плюс запас на газ — оставь хотя бы 0.003 ` +
            `${C.RH.nativeSymbol} на комиссию сети`, 'bad');
        return;
      }
      if (bal < need) {
        const d = state.decimals[dep.token] ?? 18;
        const symd = dep.token.toLowerCase() === state.pool.currency0.toLowerCase()
          ? state.pool.sym0 : state.pool.sym1;
        log(`на кошельке ${(Number(bal) / Math.pow(10, d)).toFixed(4)} ${symd}, ` +
            `а нужно ${state.amount} — вношу НЕ ТОТ токен или не хватает`, 'bad');
        return;
      }
    } catch (e) {
      // ОТКАЗ ПРОВЕРКИ — ЭТО СТОП, А НЕ ПРЕДУПРЕЖДЕНИЕ.
      //
      // Раньше здесь стоял warn, и вход шёл дальше. Но эта же проверка
      // единственная ловит случай, когда разрядность или сторона прочитались
      // неверно: без неё окно кошелька откроется с суммой, которую никто не
      // сверял. Отказ узла — повод остановиться, а не пожать плечами.
      log('баланс не проверился: ' + e.message + ' — вход не отправляю', 'bad');
      return;
    }

    // РАЗРЕШЕНИЯ ПРОВЕРЯЕМ ДО КОШЕЛЬКА, А НЕ ПОСЛЕ.
    //
    // Поймано на первом же входе в новой сети. У автора разрешение
    // ERC20 -> Permit2 стояло, а Permit2 -> PositionManager не было: в новой
    // сети его никто не выдавал. Транзакция собралась, окно Rabby открылось,
    // и только там симуляция сказала «execution revert». Понять из этого,
    // что не хватает разрешения, нельзя ничем.
    //
    // Симуляция терминала идёт параллельно и её ответ приходит уже при
    // открытом окне — поздно. Один запрос до отправки решает вопрос.
    try {
      const now = Math.floor(Date.now() / 1000);
      // Нативной монете разрешения не нужны и не бывают: она не токен.
      const plan = depNative ? { steps: [] }
        : await C.planApprovals(state.rpc, dep.token, state.account,
                                amountRaw(), 1800, now);
      if (plan.steps.length) {
        log('не хватает разрешений: ' + plan.steps.map(x => x.what).join(', ') +
            '. Нажми «ARM — выдать разрешения», потом входи. ' +
            'Без этого кошелёк покажет «execution revert».', 'bad');
        return;
      }
    } catch (e) {
      log('разрешения не проверились: ' + e.message + ' — вход не отправляю', 'bad');
      return;
    }

    const t0 = performance.now();
    const key = state.pool;
    // ПЛАН ПЕРЕСЧИТЫВАЕМ ПОСЛЕ ВСЕХ ПРОВЕРОК, А НЕ ДО НИХ.
    //
    // Цена в терминале обновляется каждые 250 мс, и раньше здесь стоял план,
    // посчитанный ДО запросов к узлу. Пока шли проверки баланса и разрешений,
    // цена успевала смениться, и сторож ниже отменял вход словами «пул или
    // сумма сменились». Автор нажимал ВОЙТИ трижды подряд и трижды получал
    // отказ — при том что ни пул, ни сумму он не трогал.
    //
    // Правильный ответ не в том, чтобы ослабить сторожа: он защищает от входа
    // по устаревшему плану. Правильный — считать план по САМОЙ СВЕЖЕЙ цене,
    // когда все проверки уже позади.
    const pf = recalc();
    if (!pf || !pf.oneSided) {
      log('пока шли проверки, цена ушла и диапазон перестал быть односторонним — ' +
          'нажми ещё раз', 'warn');
      return;
    }
    const sqrtL = C.getSqrtRatioAtTick(pf.tickLower);
    const sqrtU = C.getSqrtRatioAtTick(pf.tickUpper);
    const amt = amountRaw();
    // Односторонняя позиция: ниже цены она состоит только из currency1,
    // выше — только из currency0.
    const liquidity = pf.oneSided && dep.side === 'down'
      ? C.liquidityForAmount1(sqrtL, sqrtU, amt)
      : C.liquidityForAmount0(sqrtL, sqrtU, amt);
    // Неиспользуемой стороне ставим 0: если цена войдёт в диапазон, пока
    // автор подписывает, транзакция откажет, а не потратит второй токен.
    const data = C.buildMintCalldata({
      key, tickLower: pf.tickLower, tickUpper: pf.tickUpper, liquidity,
      amount0Max: dep.side === 'down' ? 0n : amt,
      amount1Max: dep.side === 'down' ? amt : 0n,
      owner: state.account,
      deadline: Math.floor(Date.now() / 1000) + 90,
    });
    // Сторож остался, но сторожит он ПУЛ И СУММУ, а не тик цены.
    //
    // Цена меняется четыре раза в секунду, и требовать её неизменности значит
    // не пускать никогда. Смена пула или суммы — другое дело: это значит, что
    // человек передумал, пока шли запросы, и отправлять старое нельзя.
    // Свежесть цены обеспечена тем, что план посчитан строкой выше.
    if (state.pool !== snapPool || state.amount !== snapAmount) {
      log('пул или сумма сменились, пока я считал — вход отменён, нажми ещё раз', 'warn');
      return;
    }
    if (Date.now() - state.slot0At > 5000) {
      log('цена перестала обновляться — вход не отправляю, проверь узел', 'bad');
      return;
    }
    log(`собрал за ${(performance.now() - t0).toFixed(1)} мс, открываю кошелёк`);
    state.busy = true;

    // Симуляция ПАРАЛЛЕЛЬНО: ответ придёт, пока читаешь окно Rabby.
    // В паре с нативной монетой она уходит значением транзакции; сдачу
    // вернёт SWEEP, добавленный в сборку.
    const txValue = depNative ? amountRaw() : 0n;
    C.simulate(state.rpc, state.account, C.RH.positionManager, data, txValue)
      .then(r => log(r.ok ? 'симуляция: пройдёт' : 'СИМУЛЯЦИЯ НЕ ПРОШЛА: ' + r.why,
                     r.ok ? 'ok' : 'bad'));
    try {
      const h = await W.send({ from: state.account, to: C.RH.positionManager, data,
                              value: '0x' + txValue.toString(16) });
      log('вход отправлен: ' + h, 'ok');
      // Запоминаем вход: сумму, цену и время. Сеть этого не хранит, а без
      // него честного итога после закрытия не посчитать.
      // ВНЕСЁННОЕ ЗАПИСЫВАЕМ В СТЕЙБЛЕ, А НЕ В ТОМ, ЧЕМ ЗАШЛИ.
      //
      // Здесь была ошибка, которую автор поймал на живой сделке. В режиме
      // «продать монету за стейбл» вносится МОНЕТА, и сюда попадало её
      // количество — 434198.78 MADE. Потом итог сравнивал это число с
      // деньгами, вернувшимися в USDG, и карточка показала «убыток
      // −$434039.10, −99.96%» на сделке, где вернулось 159.68 USDG.
      //
      // Правило то же, что при чтении из цепочки и у Кристала с Метеорой:
      // внесённое оценивается ПО ЦЕНЕ ВХОДА. Цена монеты в стейбле —
      // это priceOf(); стейбл сам себе равен.
      const stIdx = stableSide();
      const stableAddr = stIdx === null ? null
        : (stIdx === 1 ? key.currency1 : key.currency0);
      const depIsStable = stableAddr != null &&
        dep.token.toLowerCase() === stableAddr.toLowerCase();
      const priceCoin = priceOf(state.slot0.tick);      // стейбла за монету
      const amountInStable = depIsStable ? state.amount
                                         : state.amount * (priceCoin || 0);
      const depSymbol = dep.token.toLowerCase() === (key.currency0 || '').toLowerCase()
        ? state.pool.sym0 : state.pool.sym1;
      pendingEntry = { amountIn: amountInStable, tEntry: Date.now(),
                       // То, чем реально зашли — для честной подписи в карточке.
                       amountInToken: state.amount, symIn: depSymbol,
                       depIsStable,
                       priceIn: priceCoin, hash: h,
                       token0: key.currency0, token1: key.currency1,
                       pair: `${state.pool.sym0}/${state.pool.sym1}`,
                       fee: state.pool.fee };
      if (!depIsStable && !priceCoin) {
        log('цена входа не прочиталась — итог по этой позиции будет неточным', 'warn');
      }
      setTimeout(() => bindEntry(), 6000);
      setTimeout(loadPositions, 6000);
    } catch (e) {
      log('кошелёк отказал: ' + e.message, 'bad');
    } finally {
      // ФЛАГ СНИМАЕТСЯ ОТВЕТОМ КОШЕЛЬКА, А НЕ ТАЙМЕРОМ.
      //
      // Раньше здесь стоял setTimeout на 4 секунды, а окно Rabby ждёт
      // подтверждения десятки секунд. Второй Enter через пять секунд слал
      // ВТОРУЮ заявку на те же деньги: две позиции, двойная сумма.
      state.busy = false;
    }
  }

  // Привязка записи о входе к номеру NFT: номер известен только после того,
  // как транзакция попала в блок.
  let pendingEntry = null;
  async function bindEntry() {
    if (!pendingEntry) return;
    // НОМЕР ПОЗИЦИИ БЕРЁМ ИЗ КВИТАНЦИИ, А НЕ У ОБОЗРЕВАТЕЛЯ.
    //
    // В версии для Robinhood здесь стоял запрос в Blockscout. На BSC такого
    // обозревателя с открытым API нет: BscScan просит ключ. Но лезть наружу
    // и не надо — номер NFT лежит в самой квитанции транзакции, которую
    // отдаёт узел: это событие Transfer от PositionManager, где получатель —
    // наш адрес, а третья тема и есть номер. Так надёжнее и работает в любой
    // сети, где бы ни оказался терминал.
    try {
      const TRANSFER =
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const rc = await state.rpc('eth_getTransactionReceipt', [pendingEntry.hash]);
      if (!rc) { setTimeout(bindEntry, 4000); return; }
      if (rc.status && BigInt(rc.status) === 0n) {
        log('вход не прошёл: сеть отклонила транзакцию', 'bad');
        pendingEntry = null; return;
      }
      const me = (state.account || '').toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const mint = (rc.logs || []).find(l =>
        (l.address || '').toLowerCase() === C.RH.positionManager &&
        (l.topics || [])[0] === TRANSFER &&
        ((l.topics || [])[2] || '').toLowerCase().endsWith(me) &&
        (l.topics || []).length === 4);
      const id = mint ? String(BigInt(mint.topics[3])) : null;
      if (!id) { setTimeout(bindEntry, 4000); return; }
      ledger.put(String(id), pendingEntry);
      log(`вход записан: позиция ${id}, ${pendingEntry.amountIn} по цене ` +
          `${pendingEntry.priceIn.toPrecision(6)}`, 'ok');
      pendingEntry = null;
      loadPositions();
    } catch (e) { setTimeout(bindEntry, 4000); }
  }

  // Номера позиций, у которых ликвидность оказалась нулевой. Живёт в памяти
  // страницы: после перезагрузки проверим заново, чтобы не унаследовать
  // ошибочный вывод, но внутри сеанса не переспрашиваем.
  const emptyIds = new Set();

  // ── БАЛАНС ТОКЕНА ВЗНОСА ────────────────────────────────────────────────
  //
  // В режиме «продать монету за стейбл» сумма вводится в ШТУКАХ МОНЕТЫ, и
  // набирать их руками неудобно: у монеты по 0.0046 это шестизначное число.
  // Баланс терминал и так читает перед открытием кошелька — просто делаем
  // это раньше и показываем.
  let depBal = null;          // {token, sym, dec, human}

  // ── ЧТО НА КОШЕЛЬКЕ В ЭТОЙ СЕТИ ─────────────────────────────────────────
  //
  // Просьба автора: показывать стейблы в BNB Chain так же, как в Robinhood —
  // «чтобы видно было, с чем можно работать». Раньше баланс появлялся только
  // ПОСЛЕ загрузки пула и только по той монете, которой заходишь.
  //
  // Показываем нативную монету (на неё платится газ) и стейблы сети. Нулевые
  // не прячем: ноль USDT — это тоже ответ на вопрос «с чем работать».
  async function loadWalletBalances() {
    const host = $('walletbal');
    if (!host) return;
    if (!state.account || !state.rpc) { host.textContent = ''; return; }
    const parts = [];
    try {
      const nat = BigInt(await state.rpc('eth_getBalance', [state.account, 'latest']));
      parts.push(`${(Number(nat) / 1e18).toFixed(4)} ${C.RH.nativeSymbol}`);
    } catch (e) { parts.push(`${C.RH.nativeSymbol} не прочитался`); }
    for (const t of (C.RH.wallet || [])) {
      try {
        const raw = BigInt(await C.ethCall(state.rpc, t.addr,
          C.SEL.balanceOf + C.addrWord(state.account)));
        parts.push(`${(Number(raw) / Math.pow(10, t.dec)).toFixed(2)} ${t.sym}`);
      } catch (e) { parts.push(`${t.sym} не прочитался`); }
    }
    host.innerHTML = 'на кошельке: <b>' + parts.map(esc).join('</b> · <b>') + '</b>';
  }

  async function loadBalance() {
    $('bal').textContent = '';
    depBal = null;
    if (!state.pool || !state.account) return;
    let dep;
    try { dep = resolveSide(); } catch (e) { return; }
    const token = dep.token;
    const sym = token.toLowerCase() === (state.pool.currency0 || '').toLowerCase()
      ? state.pool.sym0 : state.pool.sym1;
    try {
      const raw = BigInt(await C.ethCall(state.rpc, token,
        C.SEL.balanceOf + C.addrWord(state.account)));
      const dec = state.decimals[token] ?? await tokenDecimals(token);
      const human = Number(raw) / Math.pow(10, dec);
      // Точный баланс в минимальных единицах храним отдельно: доли считаются
      // по нему, а не по числу с плавающей точкой.
      depBal = { token, sym, dec, human, raw };
      $('bal').innerHTML = `на кошельке <b class="num">${fmtNum(human)}</b> ${esc(sym)}`;
    } catch (e) {
      // Молчаливый ноль здесь опаснее пустоты: по нему нельзя считать доли.
      $('bal').innerHTML = '<span class="warn">баланс не прочитался</span>';
    }
    amtRow();
  }

  // Строка суммы: в покупке — доллары, в продаже — доли своего баланса.
  function amtRow() {
    const sell = state.intent === 'sell';
    const sym = depBal ? depBal.sym : (sell ? 'монета' : quoteSym());
    $('l-amt').textContent = sell ? `сколько монеты продаём, ${sym}` : `сумма, ${sym}`;
    if (!sell) {
      // Суммы под реальную работу: прежние 1/2/5/10 остались от проверок на
      // живых деньгах, когда важно было рисковать двумя долларами. Автор
      // сказал, что теми кнопками не пользуется вовсе.
      // В долларах и в BNB нужны РАЗНЫЕ кнопки. Пятьсот BNB — это полмиллиона
      // долларов; такую кнопку нельзя показывать рядом с «войти».
      const inBnb = /^(bnb|wbnb)$/i.test(depBal ? depBal.sym : quoteSym());
      chips($('r-amt'), inBnb ? [0.05, 0.1, 0.25, 0.5, 1] : [50, 100, 200, 250, 500],
            '', () => state.amount, v => state.amount = v);
      return;
    }
    // Доли от баланса. 100% намеренно НЕ значение по умолчанию: подставить
    // весь баланс и оставить его выбранным — это ровно то состояние, в
    // котором легче всего нажать «ВОЙТИ» не глядя.
    const host = $('r-amt');
    host.innerHTML = '';
    for (const pct of [25, 50, 75, 100]) {
      const b = document.createElement('button');
      b.textContent = pct + '%';
      b.disabled = !depBal;
      b.onclick = () => {
        if (!depBal) return;
        // ДОЛЮ БАЛАНСА СЧИТАЕМ В ЦЕЛЫХ, А НЕ ЧЕРЕЗ ДРОБНОЕ ЧИСЛО.
        //
        // Найдено аудитом 09.09.2026. Путь «баланс -> обычное число -> обратно
        // в минимальные единицы» у токена с 18 знаками в ПОЛОВИНЕ случаев даёт
        // на несколько наноединиц БОЛЬШЕ, чем есть на кошельке (проверено на
        // 200 000 случайных балансов, худший случай +3e-9 токена). Для «100%»
        // это значит отказ транзакции и сообщение «не хватает» на ровном месте.
        //
        // Поэтому доля берётся от точного баланса в минимальных единицах, а
        // человеческое число остаётся только для показа.
        state.amountRaw = depBal.raw * BigInt(pct) / 100n;
        state.amountRawToken = depBal.token;
        state.amount = Number(state.amountRaw) / Math.pow(10, depBal.dec);
        amtRow(); recalc(); save();
        log(`взял ${pct}% баланса: ${fmtNum(state.amount)} ${depBal.sym}`);
      };
      host.appendChild(b);
    }
    const own = document.createElement('input');
    own.type = 'text'; own.className = 'own'; own.placeholder = 'своё';
    own.value = state.amount ? String(state.amount) : '';
    own.onchange = () => {
      const v = parseFloat(String(own.value).replace(',', '.'));
      if (!isFinite(v) || v <= 0) { own.style.borderColor = 'var(--bad)'; return; }
      own.style.borderColor = '';
      // Ввели руками — точное значение доли больше не относится к делу.
      state.amount = v; state.amountRaw = null; state.amountRawToken = null;
      recalc(); save();
    };
    host.appendChild(own);
  }

  // ── позиции ─────────────────────────────────────────────────────────────
  // ── ПОЗИЦИИ И КОМИССИИ ОБНОВЛЯЮТСЯ САМИ ─────────────────────────────────
  //
  // Цена в терминале живая с самого начала — она перечитывается четыре раза в
  // секунду. А вот состав позиции и накопленные комиссии до сих пор читались
  // только по кнопке и после сделок. Автор справедливо ожидал, что они тоже
  // идут сами: цена движется — значит и комиссии капают.
  //
  // Раз в 20 секунд: чаще незачем (комиссии за 20 секунд меняются на копейки),
  // а каждый проход — это несколько запросов на каждую позицию.
  //
  // Три условия молчания, каждое по делу:
  //   * идёт отправка транзакции — узел нужен ей, а не обновлению;
  //   * вкладка не на экране — незачем жечь запросы в фоне;
  //   * предыдущий проход ещё идёт — иначе они наложатся друг на друга.
  let posTimer = null, posBusy = false;
  function startPositionsPump() {
    if (posTimer) clearInterval(posTimer);
    posTimer = setInterval(async () => {
      if (!state.account || state.busy || posBusy) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      posBusy = true;
      try {
        await loadPositions();
        await loadWalletBalances();
      } catch (e) { /* тихо: это фон */ }
      finally { posBusy = false; }
    }, 20000);
  }

  async function loadPositions() {
    const run = ++posRun;
    const stale = () => run !== posRun;
    const tb = $('pos').querySelector('tbody');
    if (!state.account) { tb.innerHTML = '<tr><td colspan="7" class="hint">подключи кошелёк</td></tr>'; return; }
    tb.innerHTML = '<tr><td colspan="7" class="hint">читаю…</td></tr>';
    let ids = [];
    try {
      // ЖУРНАЛ СОБЫТИЙ ЧИТАЕМ ЧЕРЕЗ ПУБЛИЧНЫЙ УЗЕЛ.
      //
      // Бесплатный тариф Alchemy разрешает eth_getLogs всего по 10 блоков за
      // запрос — при блоках по 0.1 секунды это одна секунда истории, искать
      // так невозможно. Публичный узел Robinhood отдаёт сразу сотни тысяч
      // блоков. Скорость от этого не страдает: цена и вход по-прежнему идут
      // через твой быстрый узел, а журнал нужен только для списка позиций.
      // Раньше здесь шёл перебор окнами на 60 000 блоков — три тяжёлых
      // запроса, дающих всего 1.7 часа истории, и узел на них отвечал
      // «internal server error». Один запрос по всей истории и дешевле,
      // и полнее: фильтр по адресу делает глубину бесплатной.
      const from = C.RH.deepLogs ? 0 : -(C.RH.logsWindow || 5000);
      ids = (await C.readAllPositions(logsRpc(), state.account, from)).map(x => x.id);
    } catch (e) { log('позиции не прочитались: ' + e.message, 'warn'); }
    // Свои позиции знаем сами: обозреватель индексирует новую NFT с
    // задержкой до полуминуты, и всё это время позиция «пропадала».
    // Номера, которые мы открыли сами, добавляем сразу и читаем прямо
    // из контракта.
    for (const k of Object.keys(ledger.all())) {
      if (!ids.includes(k)) ids.unshift(k);
    }
    if (stale()) return;
    if (!ids.length) { tb.innerHTML = '<tr><td colspan="7" class="hint">позиций нет</td></tr>'; return; }
    // Таблицу НЕ очищаем здесь: впереди отсев пустых оболочек, и на это время
    // должно оставаться «читаю…». Пустая таблица читается как «позиций нет».
    tb.innerHTML = `<tr><td colspan="7" class="hint">читаю ${ids.length} позиций…</td></tr>`;
    let shown = 0;
    const found = [];              // для переключателя верхней шкалы
    // СНАЧАЛА ОТСЕИВАЕМ ПУСТЫЕ, ПОТОМ РЕЖЕМ СПИСОК.
    //
    // Раньше стояло ids.slice(0, 40) ДО проверки ликвидности. Пустых оболочек
    // остаётся много — у этого кошелька их больше сотни, — и позиция с
    // деньгами, оказавшаяся старше сорока последних NFT, просто исчезала из
    // таблицы вместе с кнопкой «Закрыть». Экран при этом честно писал
    // «открытых позиций нет».
    //
    // Проверка ликвидности — это один eth_call на позицию, дешевле, чем
    // потерять доступ к выходу.
    // ОТСЕВ ПАРАЛЛЕЛЬНО, А НЕ ПО ОДНОЙ.
    //
    // Первая версия этой правки шла по всем NFT подряд: у этого кошелька их
    // больше сотни, один eth_call на каждую — и таблица стояла пустой почти
    // полминуты. Автор увидел пустой список и решил, что позиций нет.
    // Лечится не возвратом к срезу (из-за него позиция и терялась), а тем,
    // что запросы идут пачками.
    //
    // Восемь за раз: свой узел это держит спокойно, а очередь из ста
    // тридцати превращается в полтора десятка кругов.
    const live = [];
    const BATCH = 8;
    for (let i = 0; i < ids.length; i += BATCH) {
      // Пустые оболочки, которые уже видели, второй раз не спрашиваем.
      // Закрытая позиция обратно не наполняется — терминал этого не умеет и
      // не будет. За сеанс это превращает повторный обход ста сорока восьми
      // позиций в почти мгновенный.
      const part = ids.slice(i, i + BATCH).filter(id => !emptyIds.has(String(id)));
      const got = await Promise.all(part.map(async (id) => {
        try {
          const q = await C.readPositionLiquidity(state.rpc, id);
          if (q === 0n) emptyIds.add(String(id));
          return q > 0n ? { id, liq: q } : null;
        } catch (e) { return null; }   // не прочиталась — не выдаём за пустую
      }));
      if (stale()) return;
      for (const g of got) if (g) live.push(g);
      if (live.length >= 40) break;               // столько всё равно не бывает
      // Видно, что работа идёт, а не «зависло».
      if (i % (BATCH * 4) === 0) {
        tb.innerHTML = `<tr><td colspan="7" class="hint">читаю позиции… ` +
          `${Math.min(i + BATCH, ids.length)} из ${ids.length}</td></tr>`;
      }
    }
    if (stale()) return;
    // Заголовок «читаю…» держим до первой строки: пустая таблица читается как
    // «позиций нет», а это не то же самое, что «ещё считаю».
    tb.innerHTML = '';
    for (const { id, liq } of live) {
      let info = null;
      try {
        info = await C.readPositionPool(state.rpc, id);
      } catch (e) { continue; }
      if (stale()) return;
      shown++;
      const t = C.unpackTicks(info.info);
      const poolId = poolIdOf(info.key);
      let s0 = null, fees = null;
      try { s0 = await C.readSlot0(state.rpc, poolId); } catch (e) { /* нет цены */ }
      try {
        fees = await C.readFees(state.rpc, poolId, id, t.tickLower, t.tickUpper,
                                window.keccak256);
      } catch (e) { /* комиссии не критичны */ }
      const d0 = await tokenDecimals(info.key.currency0);
      const d1 = await tokenDecimals(info.key.currency1);
      const sym0 = await tokenSymbol(info.key.currency0);
      const sym1 = await tokenSymbol(info.key.currency1);

      // СОСТАВ: сколько чего лежит сейчас и сколько это в стейбле.
      let comp = '—', valueStr = '—', total = null, stableSym = sym1, feesValue = 0;
      if (s0) {
        const a = C.amountsForLiquidity(
          s0.sqrtPriceX96, C.getSqrtRatioAtTick(t.tickLower),
          C.getSqrtRatioAtTick(t.tickUpper), liq);
        const raw = Math.pow(1.0001, s0.tick) * Math.pow(10, d0 - d1);
        const n0 = Number(a.amount0) / Math.pow(10, d0);
        const n1 = Number(a.amount1) / Math.pow(10, d1);
        // СТОИМОСТЬ СЧИТАЕМ В СТЕЙБЛЕ, а не в currency1.
        // Здесь была ошибка: у пары USDG/TAOBAO стоимость выходила
        // «3335 TAOBAO», а итог показывал +166690%. Стейбл может стоять
        // первым, и тогда пересчитывать надо в него, а не в него же наоборот.
        const st = STABLE.test(sym1 || '') ? 1 : (STABLE.test(sym0 || '') ? 0 : 1);
        stableSym = st === 1 ? sym1 : sym0;
        let v0, v1;
        if (st === 1) { v0 = n0 * raw; v1 = n1; }          // стейбл — второй
        else { v0 = n0; v1 = raw ? n1 / raw : 0; }         // стейбл — первый
        total = v0 + v1;
        const pc = (v) => total > 0 ? (v / total * 100).toFixed(0) + '%' : '—';
        comp = `${fmtNum(n0)} ${esc(sym0)} <span class="dim">${pc(v0)}</span><br>` +
               `${fmtNum(n1)} ${esc(sym1)} <span class="dim">${pc(v1)}</span>`;
        if (fees) {
          const g0 = Number(fees.fee0) / Math.pow(10, d0);
          const g1 = Number(fees.fee1) / Math.pow(10, d1);
          feesValue = st === 1 ? g0 * raw + g1 : g0 + (raw ? g1 / raw : 0);
        }
        valueStr = `${total.toFixed(4)} ${esc(stableSym)}` +
          (fees ? `<br><span class="ok">+${feesValue.toFixed(4)} комиссий</span>` +
                  `<br><span class="dim">итого ${(total + feesValue).toFixed(4)}</span>` : '');
      }

      // ВРЕМЯ В ПОЗИЦИИ И ИТОГ — СЧИТАЕМ ПОСЛЕ ОТРИСОВКИ СТРОКИ.
      //
      // Поиск входа ходит в журнал сети и занимает секунды. Строка ждала его,
      // и автор открыл позицию с реальными деньгами, а в таблице её не
      // было — вместе с кнопкой «Закрыть». Позицию надо показывать сразу,
      // а вход дописывать, когда посчитается.
      let timeStr = '—';
      let pnlStr = '<span class="dim">ищу вход в цепочке…</span>';
      const timeOf = (rec) => {
        if (!rec || !rec.tEntry) return '—';
        const mins = (Date.now() - rec.tEntry) / 60000;
        return (mins < 60 ? `${mins.toFixed(0)} мин` : `${(mins / 60).toFixed(1)} ч`) +
               (rec.entryPrice
                 ? `<br><span class="dim">вход по ${fmtPrice(rec.entryPrice)}</span>` : '');
      };
      // ЕСЛИ ЗАКРЫТЬ И ПРОДАТЬ ПРЯМО СЕЙЧАС.
      //
      // Наивная оценка «стоимость плюс комиссии» завышена: чтобы получить
      // чистый стейбл, монету надо продать, а продажа платит комиссию пула.
      // У пула с комиссией 5% это заметные деньги, и молчать о них нельзя.
      let cashOut = null, cashWhy = null;
      if (total != null && s0) {
        // КОМИССИЯ ПРОДАЖИ: 0x800000 — ЭТО НЕ 839%, А ФЛАГ.
        //
        // Найдено аудитом 09.09.2026. У пула с ПЛАВАЮЩЕЙ комиссией в ключе
        // стоит 0x800000 = 8388608, и деление на миллион давало долю 8.39,
        // то есть множитель (1 − 8.39) = −7.39. Строка «закрыть и продать
        // сейчас» показывала бы уверенный минус там, где выход в плюсе:
        // на примере 50 стейбла и миллиона монет по 0.00005 выходило
        // −319.43 вместо ~97.50.
        //
        // У плавающей комиссии берём ЗАМЕРЕННУЮ по обменам, если она есть.
        // Если замера нет — не показываем строку вовсе и говорим почему.
        const feeRaw = info.key.fee || 0;
        const measured = feeCache.get(poolId);
        let feeShare = feeRaw === 0x800000
          ? (measured && measured.pays ? measured.median / 1000000 : null)
          : feeRaw / 1000000;
        if (feeShare == null || !(feeShare >= 0) || feeShare > 0.5) {
          feeShare = null;
          cashWhy = feeRaw === 0x800000
            ? 'у пула плавающая комиссия и она ещё не замерена'
            : 'комиссия пула выглядит неправдоподобно';
        }
        if (feeShare == null) { /* считать нечем — строки не будет */ }
        const raw2 = Math.pow(1.0001, s0.tick) * Math.pow(10, d0 - d1);
        const stIdx2 = STABLE.test(sym1 || '') ? 1 : 0;
        const a2 = C.amountsForLiquidity(
          s0.sqrtPriceX96, C.getSqrtRatioAtTick(t.tickLower),
          C.getSqrtRatioAtTick(t.tickUpper), liq);
        const coinQty = (stIdx2 === 1 ? Number(a2.amount0) / Math.pow(10, d0)
                                      : Number(a2.amount1) / Math.pow(10, d1))
          + (fees ? (stIdx2 === 1 ? Number(fees.fee0) / Math.pow(10, d0)
                                  : Number(fees.fee1) / Math.pow(10, d1)) : 0);
        const stableQty = (stIdx2 === 1 ? Number(a2.amount1) / Math.pow(10, d1)
                                        : Number(a2.amount0) / Math.pow(10, d0))
          + (fees ? (stIdx2 === 1 ? Number(fees.fee1) / Math.pow(10, d1)
                                  : Number(fees.fee0) / Math.pow(10, d0)) : 0);
        const coinPrice = stIdx2 === 1 ? raw2 : (raw2 ? 1 / raw2 : 0);
        if (feeShare != null) cashOut = stableQty + coinQty * coinPrice * (1 - feeShare);
      }

      const pnlOf = (rec) => {
        let pnlStr = '—';
      if (rec && rec.amountIn != null && total != null &&
          !entryUsable(rec, (total || 0) + (feesValue || 0))) {
        pnlStr = '<span class="warn">вход записан в монете, а не в стейбле — ' +
                 'итог по этой позиции не считаю</span>';
      } else if (rec && rec.amountIn != null && total != null) {
        // ИТОГ = стоимость позиции ПЛЮС накопленные комиссии.
        // Раньше комиссии показывались отдельной зелёной строкой, но в итог
        // не входили: позиция с +13.29 комиссий показывала минус 6.11.
        // Автор справедливо спросил, где же плюс.
        // ПЛЮС ВСЁ, ЧТО УЖЕ ВЫНУТО. После снятия комиссий или закрытия половины
        // тело уменьшается, а вход остаётся прежним — без этого слагаемого
        // итог показал бы выдуманный минус ровно на снятую сумму.
        const out = rec.takenOut || 0;
        const pnl = (total + feesValue + out) - rec.amountIn;
        const pct = rec.amountIn > 0 ? (pnl / rec.amountIn * 100) : 0;
        pnlStr = `<span class="${pnl >= 0 ? 'ok' : 'bad'}">${pnl >= 0 ? '+' : ''}` +
                 `${pnl.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>` +
                 (out > 0 ? `<br><span class="dim">уже вынуто ${out.toFixed(2)}, ` +
                            `учтено в итоге</span>` : '');
        if (cashOut == null && cashWhy) {
          pnlStr += `<br><span class="dim">сколько выйдет на руки — не считаю: ` +
                    `${esc(cashWhy)}</span>`;
        }
        if (cashOut != null) {
          const net = cashOut + out - rec.amountIn;
          const netPct = rec.amountIn ? net / rec.amountIn * 100 : 0;
          pnlStr += `<br><span class="dim">закрыть и продать сейчас:</span>` +
                    `<br><b class="${net >= 0 ? 'ok' : 'bad'}">${net >= 0 ? '+' : ''}` +
                    `${net.toFixed(2)} ${esc(stableSym)} (${netPct >= 0 ? '+' : ''}${netPct.toFixed(2)}%)</b>` +
                    `<br><span class="dim">= ${cashOut.toFixed(2)} на руки, ` +
                    `комиссия продажи учтена</span>`;
        }
      } else if (total != null) {
        pnlStr = '<span class="dim">вход в цепочке не найден</span>';
      }
        return pnlStr;
      };

      const inRange = s0 && s0.tick >= t.tickLower && s0.tick < t.tickUpper;
      // Границы показываем ЦЕНОЙ, а не тиками: тик ни на одном графике не
      // отложишь, а цену — сразу. Автор отмечает уровни у себя на графике.
      // Границы — в ТЕХ ЖЕ единицах, что и цена сверху. Здесь я это забыл
      // сделать: цену перевернул, а границы оставил сырыми, и в таблице
      // выходило «Min 2610» при цене 0.0004. Автор справедливо спросил,
      // почему цена нормальная, а границы нет.
      const stIdx = STABLE.test(sym1 || '') ? 1 : (STABLE.test(sym0 || '') ? 0 : 1);
      const pAt = (tk) => {
        const raw = Math.pow(1.0001, tk) * Math.pow(10, d0 - d1);
        return stIdx === 0 ? (raw ? 1 / raw : 0) : raw;
      };
      // При перевороте нижняя граница становится верхней.
      const bLo = Math.min(pAt(t.tickLower), pAt(t.tickUpper));
      const bHi = Math.max(pAt(t.tickLower), pAt(t.tickUpper));
      let bounds = '—';
      if (s0) {
        const nowP = stIdx === 0
          ? 1 / (Math.pow(1.0001, s0.tick) * Math.pow(10, d0 - d1))
          : Math.pow(1.0001, s0.tick) * Math.pow(10, d0 - d1);
        const inside = nowP >= bLo && nowP <= bHi;
        const near = nowP < bLo ? bLo : bHi;
        const away = Math.abs(near / nowP - 1) * 100;
        // Границы позиции — в тех же единицах, что и весь экран. Выпуск берём
        // у МОНЕТЫ ЭТОЙ позиции, а не у загруженного пула.
        const coinAddr = stIdx === 0 ? info.key.currency1 : info.key.currency0;
        const sup = unit === 'cap' ? await supplyOf(coinAddr) : null;
        const showB = (v) => sup ? fmtCap(v * sup) : fmtPrice(v);
        bounds = `<span class="dim">${sup ? 'Min капа' : 'Min'}</span> ${showB(bLo)}<br>` +
                 `<span class="dim">${sup ? 'Max капа' : 'Max'}</span> ${showB(bHi)}<br>` +
                 (inside ? '<span class="ok">внутри</span>'
                         : `<span class="warn">до входа ${away.toFixed(1)}%</span>`);
      }
      // Запоминаем позицию для переключателя шкалы: пара, пул и границы.
      found.push({ id: String(id), pair: `${sym0}/${sym1}`, poolId,
                   tickLower: t.tickLower, tickUpper: t.tickUpper });

      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="num">${id}<br><span class="${inRange ? 'ok' : 'dim'}">${
          inRange ? 'в работе' : 'ждёт'}</span></td>` +
        `<td>${esc(sym0)}/${esc(sym1)}<br><span class="dim num">${timeStr}</span></td>` +
        `<td class="num">${bounds}</td>` +
        `<td class="num">${comp}</td>` +
        `<td class="num">${valueStr}</td>` +
        `<td class="num">${pnlStr}</td>` +
        // Три действия вместо одного. Комиссии в Uniswap V4 забираются тем же
        // действием DECREASE_LIQUIDITY, что и закрытие, только с нулём вместо
        // ликвидности — форма вызова та самая, что сверена байт в байт с
        // настоящими транзакциями Krystal. Все три варианта прогнаны
        // симуляцией на живой позиции: проходят.
        `<td style="white-space:nowrap">` +
        // Названия пишем от того, ЧТО ОСТАНЕТСЯ, а не от того, что уйдёт.
        // «Комиссии» и «½» автор принял за одно и то же — и правильно
        // усомнился: с виду обе «забирают деньги». Разница в теле позиции.
        `<button style="padding:4px 6px;font-size:11px" ` +
        `title="забрать накопленные комиссии; тело позиции остаётся в пуле целиком">` +
        `Комиссии<br><span class="dim" style="font-size:9px">тело целиком остаётся` +
        `</span></button> ` +
        `<button style="padding:4px 6px;font-size:11px" ` +
        `title="забрать комиссии и половину тела; вторая половина продолжает работать">` +
        `Половина<br><span class="dim" style="font-size:9px">+ все комиссии` +
        `</span></button> ` +
        `<button class="danger" style="padding:4px 6px;font-size:11px">` +
        `Закрыть<br><span class="dim" style="font-size:9px">всё и выход` +
        `</span></button></td>`;
      {
        const bs = tr.querySelectorAll('button');
        bs[0].onclick = () => closePosition(id, 0n, info.key, total, stableSym, 'fees');
        bs[1].onclick = () => closePosition(id, liq / 2n, info.key, total, stableSym, 'half');
        bs[2].onclick = () => closePosition(id, liq, info.key, total, stableSym, 'all');
      }
      // Проверяем ВПЛОТНУЮ к записи: между прошлой проверкой и этим местом
      // стоят запросы в сеть, и за это время мог начаться новый проход.
      if (stale()) return;
      tb.appendChild(tr);

      // Вход дописываем, когда найдётся. Строка с кнопкой «Закрыть» уже
      // стоит, и автор может выйти из позиции, не дожидаясь расчёта.
      (async () => {
        let rec = null;
        try { rec = await entryFromChain(id, info.key, poolId, d0, d1, sym0, sym1); }
        catch (e) { /* возьмём запись браузера */ }
        if (!rec) rec = ledger.get(String(id));
        // ВЫНУТОЕ ДОБАВЛЯЕМ ВСЕГДА, А НЕ ТОЛЬКО КОГДА ЦЕПОЧКА МОЛЧИТ.
        //
        // Запись о частичных снятиях живёт только в браузере, а вход берётся
        // с цепочки — и в обычном случае ledger вообще не читался. Из-за
        // этого после «Комиссий» строка показывала минус ровно на снятую
        // сумму, а после «Половины» — минус около 50%. То есть починка,
        // объявленная в v2.5, в основном пути не работала.
        const takenOut = (ledger.get(String(id)) || {}).takenOut;
        if (rec && takenOut) rec = { ...rec, takenOut };
        if (stale() || !tr.parentNode) return;
        tr.cells[1].innerHTML =
          `${esc(sym0)}/${esc(sym1)}<br><span class="dim num">${timeOf(rec)}</span>`;
        tr.cells[5].innerHTML = pnlOf(rec);
      })();
    }
    if (!shown) tb.innerHTML = '<tr><td colspan="7" class="hint">открытых позиций нет</td></tr>';
    // Список для переключателя обновляем ПОСЛЕ обхода: если проход устарел,
    // до сюда мы не дойдём, и старый список не будет затёрт наполовину.
    openList = found;
    if (watching && !found.some(o => o.id === watching.id)) watching = null;
    drawWatchBar();
  }

  // PoolId считается из ключа — тот же приём, что и при загрузке пула.
  // ВХОД БЕРЁМ С ЦЕПОЧКИ.
  //
  // Раньше вход жил только в памяти браузера. Автор открыл терминал и
  // увидел «вход не записан» на позиции, в которой сидел с реальными
  // деньгами: память браузера не пережила смену версии. Такой источник
  // правды о деньгах никуда не годится.
  //
  // Теперь спрашиваем цепочку: блок выпуска NFT, внесённые суммы из
  // расписки, цена того блока из событий обмена. Это факт, а не наша запись.
  // Найденное держим в памяти страницы, чтобы не искать повторно.
  // ЗАЩИТА ОТ НАЛОЖЕНИЯ ОБНОВЛЕНИЙ.
  //
  // Обновление позиций ходит в цепочку и идёт секунды. За это время можно
  // нажать кнопку ещё раз или получить событие кошелька — и два прохода
  // начинают писать в одну таблицу. В проверке позиция показалась ДВАЖДЫ.
  // Каждый проход берёт номер; писать в таблицу вправе только последний.
  let posRun = 0, histRun = 0;

  const entryCache = new Map();
  function entryFromChain(id, key, poolId, d0, d1, sym0, sym1) {
    const k = String(id);
    if (entryCache.has(k)) return entryCache.get(k);
    const p = (async () => {
      // Журнал — только через публичный узел. Alchemy отдаёт eth_getLogs
      // по 10 блоков за раз, и поиск входа там просто не работает.
      // Где узел не хранит всю историю (BSC), ищем в недавнем окне: запрос
      // с нулевого блока там отвергается, и вход «не находится» на ровном месте.
      const m = await C.findMint(logsRpc(), id,
                                 C.RH.deepLogs ? 0 : -(C.RH.mintWindow || 60000));
      if (!m) return null;
      const f = await C.txFlows(state.rpc, m.hash, state.account);
      const inflow = f ? f.flows.filter(x => x.dir < 0) : [];
      if (!inflow.length) return null;
      const pe = await C.priceAtBlock(logsRpc(), poolId, m.block);
      const tEntry = await C.blockTime(state.rpc, m.block);
      const raw = pe ? C.priceFromSqrt(pe.sqrtPriceX96, d0, d1) : null;
      // Стейбл может стоять и первым, и вторым — порядок задают адреса.
      const st = STABLE.test(sym1 || '') ? 1 : (STABLE.test(sym0 || '') ? 0 : 1);
      let amountIn = 0;
      for (const x of inflow) {
        const is0 = x.token === key.currency0.toLowerCase();
        const n = Number(x.amount) / Math.pow(10, is0 ? d0 : d1);
        const isStable = (st === 1 && !is0) || (st === 0 && is0);
        // Внесённое считаем ПО ЦЕНЕ ВХОДА — так это определено у Кристала
        // и у Метеоры, и только так процент получается честным.
        if (isStable) amountIn += n;
        else if (raw) amountIn += st === 1 ? n * raw : n / raw;
      }
      return {
        amountIn, tEntry, block: m.block, hash: m.hash, fromChain: true,
        entryPrice: raw == null ? null : (st === 1 ? raw : (raw ? 1 / raw : 0)),
      };
    })().catch(() => null);
    entryCache.set(k, p);
    return p;
  }

  function poolIdOf(key) {
    return window.keccak256('0x' +
      C.addrWord(key.currency0) + C.addrWord(key.currency1) +
      BigInt(key.fee).toString(16).padStart(64, '0') +
      (((BigInt(key.tickSpacing) + (1n << 256n)) % (1n << 256n))
        .toString(16).padStart(64, '0')).slice(-64) +
      C.addrWord(key.hooks));
  }

  const fmtNum = (v) => v === 0 ? '0'
    : Math.abs(v) >= 1000 ? v.toFixed(0)
    : Math.abs(v) >= 1 ? v.toFixed(3) : v.toPrecision(3);

  // mode: 'all' — закрыть целиком, 'half' — половину, 'fees' — только комиссии.
  //
  // Действие в цепочке одно и то же (DECREASE_LIQUIDITY + TAKE_PAIR),
  // отличается только величина снимаемой ликвидности. Комиссии приходят
  // ЦЕЛИКОМ при любом из трёх: пул отдаёт накопленное вместе с телом, а при
  // нуле — накопленное и только его.
  const MODES = {
    all:  { verb: 'закрытие', ask: (id) => `Закрыть позицию ${id} ЦЕЛИКОМ?` },
    half: { verb: 'частичное закрытие',
            ask: (id) => `Закрыть ПОЛОВИНУ позиции ${id}?\n\n` +
                         `Комиссии придут целиком, половина тела останется работать.` },
    fees: { verb: 'снятие комиссий',
            ask: (id) => `Забрать накопленные комиссии позиции ${id}?\n\n` +
                         `Тело позиции останется в пуле и продолжит работать.` },
  };

  async function closePosition(tokenId, liquidity, key, valueNow, symQuote, mode = 'all') {
    const m = MODES[mode] || MODES.all;
    // Пока висит окно кошелька, второй клик слать нельзя: заявка уйдёт
    // дважды, и подтвердить обе под рукой слишком легко. У закрытия такой
    // защиты не было вовсе.
    if (state.busy) { log('уже жду ответа кошелька', 'warn'); return; }
    if (!confirm(m.ask(tokenId))) return;
    // Снимать нечего — не гоняем кошелёк зря.
    if (mode !== 'fees' && (!liquidity || liquidity <= 0n)) {
      log('в позиции нет ликвидности — снимать нечего', 'warn');
      return;
    }
    const rec = ledger.get(String(tokenId));
    const data = C.buildCloseCalldata({
      tokenId, liquidity,
      currency0: key.currency0, currency1: key.currency1,
      amount0Min: 0n, amount1Min: 0n,
      deadline: Math.floor(Date.now() / 1000) + 120,
    });
    C.simulate(state.rpc, state.account, C.RH.positionManager, data)
      .then(r => log(r.ok ? `${m.verb}: симуляция пройдёт`
                          : `${m.verb.toUpperCase()} НЕ ПРОЙДЁТ: ` + r.why,
                     r.ok ? 'ok' : 'bad'));
    state.busy = true;
    // Баланс нативной монеты ДО отправки. Нужен только когда одна из сторон
    // пары — сам BNB: его возврат не виден ни в одном событии.
    let nativeBefore = null;
    if (isNative(key.currency0) || isNative(key.currency1)) {
      try { nativeBefore = BigInt(await state.rpc('eth_getBalance',
                                                  [state.account, 'latest'])); }
      catch (e) { nativeBefore = null; }
    }
    try {
      const h = await W.send({ from: state.account, to: C.RH.positionManager, data });
      log(`${m.verb} отправлено: ` + h, 'ok');
      // ЧЕСТНЫЙ ИТОГ. Считаем по тому, что реально вернулось, а не по
      // ожиданиям: читаем квитанцию самой транзакции.
      if (mode === 'all') settleClose(h, tokenId, rec, symQuote, key, nativeBefore);
      else settleTake(h, tokenId, symQuote, key, m.verb, nativeBefore);
      setTimeout(loadPositions, 5000);
    } catch (e) {
      log('кошелёк отказал: ' + e.message, 'bad');
    } finally { state.busy = false; }
  }

  // ЧАСТИЧНЫЙ ВЫВОД. Считать его как закрытие нельзя: вход остаётся прежним,
  // а тело уменьшилось, и итог показал бы выдуманный минус в половину суммы.
  //
  // Поэтому забранное складывается в ledger, а PnL прибавляет его к тому, что
  // осталось внутри. Позиция стоит ровно столько, сколько в ней лежит ПЛЮС всё,
  // что из неё уже вынуто.
  // ЧТО ВЕРНУЛОСЬ НАМ ИЗ ТРАНЗАКЦИИ — ПО КВИТАНЦИИ УЗЛА.
  //
  // В версии для Robinhood это читалось из Blockscout: у него готовый список
  // переводов токенов. На BSC открытого обозревателя нет, BscScan просит ключ,
  // и полагаться на чужой сервис ради денежной цифры всё равно не хочется.
  // Квитанция транзакции содержит всё нужное.
  //
  // ОДНА ТОНКОСТЬ, ИЗ-ЗА КОТОРОЙ ЭТО НЕ ПРОСТО «СЧИТАТЬ Transfer».
  // Нативный BNB события Transfer НЕ порождает. В паре монета/BNB половина
  // возврата пришла бы невидимой, и итог показал бы убыток там, где его нет.
  // Поэтому нативную сторону считаем по изменению баланса кошелька, вычитая
  // потраченный газ. Если баланс «до» снять не успели — так и говорим, а не
  // подставляем ноль: ноль здесь выглядит как настоящая цифра.

  async function receiptBack(hash, key, nativeBefore) {
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2500));
      let rc = null;
      try { rc = await state.rpc('eth_getTransactionReceipt', [hash]); }
      catch (e) { continue; }
      if (!rc) continue;
      if (rc.status != null && BigInt(rc.status) === 0n) return { failed: true };

      const me = state.account.toLowerCase().replace(/^0x/, '').padStart(64, '0');
      const back = { 0: 0, 1: 0 };
      let nativeUnknown = false;
      for (const idx of [0, 1]) {
        const cur = idx === 0 ? key.currency0 : key.currency1;
        if (isNative(cur)) {
          if (nativeBefore == null) { nativeUnknown = true; continue; }
          try {
            const after = BigInt(await state.rpc('eth_getBalance',
                                                 [state.account, 'latest']));
            const gas = BigInt(rc.gasUsed || 0) *
                        BigInt(rc.effectiveGasPrice || rc.gasPrice || 0);
            const delta = after - BigInt(nativeBefore) + gas;
            back[idx] = delta > 0n ? Number(delta) / 1e18 : 0;
          } catch (e) { nativeUnknown = true; }
          continue;
        }
        let dec = 18;
        try { dec = await tokenDecimals(cur); } catch (e) { }
        for (const l of (rc.logs || [])) {
          if ((l.address || '').toLowerCase() !== cur.toLowerCase()) continue;
          if ((l.topics || [])[0] !== TRANSFER_TOPIC) continue;
          if (((l.topics || [])[2] || '').toLowerCase().slice(-64) !== me) continue;
          back[idx] += Number(BigInt(l.data || '0x0')) / Math.pow(10, dec);
        }
      }
      return { back0: back[0], back1: back[1], nativeUnknown };
    }
    return { timeout: true };
  }

  async function settleTake(hash, tokenId, symQuote, key, verb, nativeBefore) {
    {
      const r = await receiptBack(hash, key, nativeBefore);
      if (r.failed) { log(`${verb} НЕ прошло: сеть отклонила транзакцию`, 'bad'); return; }
      if (r.timeout) { log(`${verb}: подтверждения не дождался, проверь кошелёк`, 'warn'); return; }
      const back0 = r.back0, back1 = r.back1;
      if (r.nativeUnknown)
        log(`${verb}: нативную сторону посчитать не смог, в итоге только токен`, 'warn');
      let price = 0;
      try {
        const s0 = await C.readSlot0(state.rpc, poolIdOf(key));
        price = Math.pow(1.0001, s0.tick) *
                Math.pow(10, await tokenDecimals(key.currency0) -
                             await tokenDecimals(key.currency1));
      } catch (e) { /* без цены посчитаем только в токенах */ }
      const stableIsFirst = symQuote && (await tokenSymbol(key.currency0)) === symQuote;
      const got = stableIsFirst ? back0 + (price ? back1 / price : 0)
                                : back1 + back0 * price;
      const prev = ledger.get(String(tokenId)) || {};
      const takenOut = (prev.takenOut || 0) + got;
      ledger.put(String(tokenId), { takenOut, lastTake: Date.now() });
      log(`${verb.toUpperCase()} ПРОШЛО ${tokenId}: получено ${back0.toFixed(4)} + ` +
          `${back1.toFixed(4)} = ${got.toFixed(4)} ${symQuote}. ` +
          `Всего вынуто из позиции: ${takenOut.toFixed(4)} ${symQuote} — ` +
          `итог считаю с учётом этого.`, 'ok');
      return;
    }
  }

  async function settleClose(hash, tokenId, rec, symQuote, key, nativeBefore) {
    {
      const r = await receiptBack(hash, key, nativeBefore);
      if (r.failed) { log('закрытие НЕ прошло: сеть отклонила транзакцию', 'bad'); return; }
      if (r.timeout) { log('закрытие: подтверждения не дождался, проверь кошелёк', 'warn'); return; }
      const back0 = r.back0, back1 = r.back1;
      if (r.nativeUnknown)
        log('закрытие: нативную сторону посчитать не смог, в итоге только токен', 'warn');
      let price = 0;                              // сырая: currency1 за currency0
      try {
        const s0 = await C.readSlot0(state.rpc, poolIdOf(key));
        const d0 = await tokenDecimals(key.currency0);
        const d1 = await tokenDecimals(key.currency1);
        price = Math.pow(1.0001, s0.tick) * Math.pow(10, d0 - d1);
      } catch (e) { /* без цены посчитаем только в токенах */ }
      // Итог тоже в стейбле, с какой бы стороны он ни стоял.
      const st = STABLE.test(symQuote || '') ? null : null;
      const stableIsFirst = symQuote &&
        (await tokenSymbol(key.currency0)) === symQuote;
      const got = stableIsFirst
        ? back0 + (price ? back1 / price : 0)
        : back1 + back0 * price;
      const mins = rec && rec.tEntry ? (Date.now() - rec.tEntry) / 60000 : null;
      let line = `ЗАКРЫТО ${tokenId}: вернулось ${back0.toFixed(4)} + ` +
                 `${back1.toFixed(4)} ${symQuote} = ${got.toFixed(4)} ${symQuote}`;
      if (rec && rec.amountIn != null && !entryUsable(rec, got)) {
        line += ' | вход записан в монете, а не в стейбле — итог не считаю';
      } else if (rec && rec.amountIn != null) {
        // То, что вынули раньше (комиссии, половина), входит в итог наравне
        // с тем, что вернулось сейчас. Иначе закрытие остатка выглядело бы
        // убытком ровно на снятую сумму.
        const out = (ledger.get(String(tokenId)) || {}).takenOut || 0;
        const pnl = got + out - rec.amountIn;
        const pct = rec.amountIn > 0 ? pnl / rec.amountIn * 100 : 0;
        if (out > 0) line += ` + вынуто раньше ${out.toFixed(4)}`;
        line += ` | вносил ${rec.amountIn.toFixed(4)} → ИТОГ ${pnl >= 0 ? '+' : ''}` +
                `${pnl.toFixed(4)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
        if (mins != null) line += ` за ${mins < 60 ? mins.toFixed(0) + ' мин' : (mins/60).toFixed(1) + ' ч'}`;
        // ЧТО ЕЩЁ НУЖНО КАРТОЧКЕ: границы диапазона и цена, на которой
        // вышли. Автор попросил, чтобы карточка в терминале выглядела так
        // же, как те, что я присылаю ему в Telegram, а там это есть.
        // Берём с цепочки: границы лежат в самой позиции, и после закрытия
        // NFT никуда не девается.
        let lo = null, hi = null, exitPx = null;
        try {
          const d0 = await tokenDecimals(key.currency0);
          const d1 = await tokenDecimals(key.currency1);
          const shown = (tick) => {
            const raw = Math.pow(1.0001, tick) * Math.pow(10, d0 - d1);
            if (!isFinite(raw) || raw <= 0) return null;
            return stableIsFirst ? 1 / raw : raw;
          };
          const info = await C.readPositionPool(state.rpc, tokenId);
          const t = C.unpackTicks(info.info);
          const a = shown(t.tickLower), b = shown(t.tickUpper);
          if (a && b) { lo = Math.min(a, b); hi = Math.max(a, b); }
          if (price) exitPx = stableIsFirst ? 1 / price : price;
        } catch (e) { /* без границ карточка обойдётся */ }
        ledger.put(String(tokenId), {
          closed: Date.now(), got, pnl, symStable: symQuote, lo, hi, exitPx,
        });
        // Одна карточка сразу после закрытия — как просил автор.
        // Не копятся: старая убирается перед показом новой.
        showCard(String(tokenId), { ...(ledger.get(String(tokenId)) || {}) });
      } else {
        line += ' | вход не записан, итог посчитать не с чем';
      }
      log(line, rec && rec.amountIn != null && got >= rec.amountIn ? 'ok' : 'warn');
      return;
    }
  }

  // Узел для журнала событий.
  //
  // На Robinhood публичный узел отдавал любую глубину, и это было даром.
  // На BSC всё наоборот: dataseed события не отдаёт вовсе, а тот, что отдаёт,
  // держит только недавние блоки и на старый отрезок отвечает «archive
  // requests require a personal token». Ядро это понимает и берёт новую
  // половину отрезка вместо деления вслепую, но за глубокой историей нужен
  // свой узел. Если он вставлен в поле сверху — берём его, он лучше.
  let _logsRpc = null;
  function logsRpc() {
    // ЖУРНАЛ СОБЫТИЙ ЧИТАЕМ ПУБЛИЧНЫМ УЗЛОМ, А НЕ СВОИМ.
    //
    // Это выглядит наоборот, но проверено на обеих сетях: Alchemy на
    // бесплатном тарифе eth_getLogs не отдаёт вовсе — ни на шесть тысяч
    // блоков, ни на десять. Автор вставил свой узел для BNB, и терминал
    // перестал мерить комиссию: у всех пулов встало «платит ли — неизвестно».
    // Свой узел прекрасен для eth_call и скорости, но журнал не его дело.
    //
    // Свой узел остаётся ЗАПАСНЫМ: если публичный отказал, пробуем через него,
    // вдруг тариф другой. Молчание обоих — это по-прежнему «не знаю», а не
    // «не платит».
    if (!_logsRpc) _logsRpc = C.makeRpc(C.RH.publicRpc);
    const pub = _logsRpc, own = state.rpc;
    if (!own || state.rpcUrl === C.RH.publicRpc) return pub;
    return async (method, params) => {
      try { return await pub(method, params); }
      catch (e) { return own(method, params); }
    };
  }

  // ── история сделок ──────────────────────────────────────────────────────
  //
  // Читается из журнала событий сети: все переводы токенов между кошельком
  // и PoolManager. Вход — деньги ушли, выход — вернулись. Это надёжнее наших
  // записей: показывает, что реально двигалось, даже если позиция открыта
  // не через терминал.
  // ── история сделок: каждая сторона по цене СВОЕГО момента ──────────────
  //
  // Так считают Кристал и Метеора, и только так процент честный: внесённое
  // оценивается по цене входа, полученное — по цене выхода.
  //
  // Комиссии отдельной строкой НЕ прибавляем. При закрытии пул отдаёт тело
  // позиции вместе с накопленными комиссиями одним движением — в полученных
  // суммах они уже сидят. Прибавить их ещё раз значит посчитать дважды.
  //
  // Раньше здесь была моя выдумка: цену закрытия я вычислял из самих
  // вернувшихся сумм. Она давала «цену закрытия 1.000000», сделки по
  // +21107% и итог +165 562 при обороте в тысячи. Теперь цена берётся из
  // события обмена в пуле — она там лежит готовая.
  // Блок в этой сети ~0.101 с — этим меряем время в позиции.
  const BLOCK_SEC = 0.101;
  const HIST_LIMIT = 25;

  async function loadHistory() {
    const run = ++histRun;
    const stale = () => run !== histRun;
    const tb = $('hist').querySelector('tbody');
    if (!state.account || !state.rpc) {
      tb.innerHTML = '<tr><td colspan="4" class="hint">нужны кошелёк и узел</td></tr>';
      return;
    }
    tb.innerHTML = '<tr><td colspan="4" class="hint">читаю цепочку…</td></tr>';

    let all = [];
    // Там, где узел не хранит глубину, «история сделок» честно невозможна:
    // спрашивать её значит ждать минуты и получить «Load failed».
    if (!C.RH.deepLogs && (!state.rpcUrl || /publicnode\.com/i.test(state.rpcUrl))) {
      tb.innerHTML = '<tr><td colspan="4" class="hint">в этой сети публичный узел ' +
        'хранит только недавние блоки — истории сделок по нему не собрать. ' +
        'Нужен архивный узел; открытые позиции при этом видны как обычно.</td></tr>';
      return;
    }
    try { all = await C.readAllPositions(logsRpc(), state.account,
                                         C.RH.deepLogs ? 0 : -(C.RH.logsWindow || 5000)); }
    catch (e) {
      tb.innerHTML = '<tr><td colspan="4" class="hint">узел не отдал историю: ' +
                     (e.message || '') + '</td></tr>';
      return;
    }
    if (!all.length) {
      tb.innerHTML = '<tr><td colspan="4" class="hint">позиций не было</td></tr>';
      return;
    }
    const take = all.slice(0, HIST_LIMIT);

    // Раскладываем по пулам: события ликвидности читаются пулом целиком,
    // так на десяток позиций уходит пара запросов вместо десятка.
    const pools = new Map();
    for (const it of take) {
      let info;
      try { info = await C.readPositionPool(state.rpc, it.id); } catch (e) { continue; }
      const pid = poolIdOf(info.key);
      if (!pools.has(pid)) pools.set(pid, { key: info.key, items: [], from: it.block });
      const g = pools.get(pid);
      g.items.push({ ...it, info });
      g.from = Math.min(g.from, it.block);
    }

    const rows = [];
    for (const [pid, g] of pools) {
      const d0 = await tokenDecimals(g.key.currency0);
      const d1 = await tokenDecimals(g.key.currency1);
      const s0 = await tokenSymbol(g.key.currency0);
      const s1 = await tokenSymbol(g.key.currency1);
      const st = STABLE.test(s1 || '') ? 1 : (STABLE.test(s0 || '') ? 0 : 1);
      const stableSym = st === 1 ? s1 : s0;

      let events;
      try { events = await C.readPositionEvents(logsRpc(), pid, g.from, g.items.map(x => x.id)); }
      catch (e) { continue; }
      // Узел мог не отдать часть журнала. Молчать об этом нельзя: тогда
      // неполная история выглядит как полная, и сделка без выхода — как
      // сделка, которой не было.
      if (events.missed) {
        log(`история ${s0}/${s1}: ${events.missed} кусок(ов) журнала узел не отдал — ` +
            `часть сделок может не показаться, обнови ещё раз`, 'warn');
      }

      // Одна транзакция может закрыть несколько позиций сразу. Тогда её
      // движения относятся ко всем сразу, и приписать их одной — соврать.
      // Считаем, сколько наших позиций в каждой транзакции.
      const share = new Map();
      for (const it of g.items) {
        for (const ev of (events.get(it.id) || [])) {
          const k = ev.hash + (ev.delta > 0n ? ':in' : ':out');
          share.set(k, (share.get(k) || 0n) + (ev.delta > 0n ? ev.delta : -ev.delta));
        }
      }

      // Стоимость движений транзакции по цене её собственного блока.
      const valueAt = async (ev, dir) => {
        const f = await C.txFlows(state.rpc, ev.hash, state.account);
        const pr = await C.priceAtBlock(logsRpc(), pid, ev.block);
        const raw = pr ? C.priceFromSqrt(pr.sqrtPriceX96, d0, d1) : null;
        const mine = ev.delta > 0n ? ev.delta : -ev.delta;
        const whole = share.get(ev.hash + (dir < 0 ? ':in' : ':out')) || mine;
        const part = whole > 0n ? Number(mine) / Number(whole) : 1;
        let v = 0; const parts = [];
        for (const x of (f ? f.flows.filter(y => y.dir === dir) : [])) {
          const is0 = x.token === g.key.currency0.toLowerCase();
          const n = (Number(x.amount) / Math.pow(10, is0 ? d0 : d1)) * part;
          const isStable = (st === 1 && !is0) || (st === 0 && is0);
          v += isStable ? n : (raw ? (st === 1 ? n * raw : n / raw) : 0);
          parts.push(`${fmtNum(n)} ${is0 ? s0 : s1}`);
        }
        return {
          v, parts,
          coinPx: raw == null ? null : (st === 1 ? raw : (raw ? 1 / raw : 0)),
          split: part < 1,
          ok: !!f && raw != null,
        };
      };

      for (const it of g.items) {
        const e = events.get(it.id) || [];
        const open = e.find(x => x.delta > 0n);
        const close = e.filter(x => x.delta < 0n).pop();
        if (!open) continue;
        const IN = await valueAt(open, -1);
        const OUT = close ? await valueAt(close, 1) : null;
        rows.push({
          id: it.id, pair: `${s0}/${s1}`, stableSym,
          openBlock: open.block, closeBlock: close ? close.block : null,
          IN, OUT,
          mins: close ? (close.block - open.block) * BLOCK_SEC / 60 : null,
        });
      }
    }

    rows.sort((a, b) => (b.closeBlock || b.openBlock) - (a.closeBlock || a.openBlock));

    if (stale()) return;
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="4" class="hint">сделок не нашёл</td></tr>';
      return;
    }

    if (stale()) return;
    tb.innerHTML = '';
    let total = 0, counted = 0;
    for (const r of rows) {
      const tr = document.createElement('tr');
      let res;
      if (!r.OUT) {
        res = '<span class="dim">ещё открыта</span>';
      } else if (!r.IN.ok || !r.OUT.ok) {
        res = '<span class="dim">цену момента не достал — итог не показываю</span>';
      } else {
        const pnl = r.OUT.v - r.IN.v;
        const pct = r.IN.v > 0 ? pnl / r.IN.v * 100 : 0;
        total += pnl; counted++;
        const approx = r.IN.split || r.OUT.split;
        res = `<span class="${pnl >= 0 ? 'ok' : 'bad'}">${approx ? '≈' : ''}` +
              `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} · ${pct >= 0 ? '+' : ''}` +
              `${pct.toFixed(2)}%</span><br><span class="dim">` +
              `${r.IN.v.toFixed(2)} → ${r.OUT.v.toFixed(2)} ${esc(r.stableSym)}</span>` +
              (approx ? '<br><span class="hint">закрыто вместе с другими, ' +
                        'суммы делю по ликвидности</span>' : '');
      }
      const px = (x) => x && x.coinPx ? fmtPrice(x.coinPx) : '—';
      tr.innerHTML =
        `<td class="num dim">${r.closeBlock || r.openBlock}` +
        `<br><span class="hint">NFT ${r.id}</span></td>` +
        `<td>${esc(r.pair)}${r.mins != null
            ? `<br><span class="dim">${r.mins < 60 ? r.mins.toFixed(0) + ' мин'
                                                   : (r.mins / 60).toFixed(1) + ' ч'}</span>` : ''}</td>` +
        `<td class="num"><span class="dim">внёс</span> ${r.IN.parts.join(' + ') || '—'}` +
        `<br><span class="hint">монета по ${px(r.IN)}</span>` +
        (r.OUT ? `<br><span class="dim">забрал</span> ${r.OUT.parts.join(' + ') || '—'}` +
                 `<br><span class="hint">монета по ${px(r.OUT)}</span>` : '') +
        `</td><td>${res}</td>`;
      // Проверяем ВПЛОТНУЮ к записи: между прошлой проверкой и этим местом
      // стоят запросы в сеть, и за это время мог начаться новый проход.
      if (stale()) return;
      tb.appendChild(tr);
    }

    const head = document.createElement('tr');
    head.innerHTML =
      `<td colspan="3"><b>итог по ${counted} закрытым сделкам</b>` +
      `<br><span class="hint">внесённое по цене входа, полученное по цене выхода — ` +
      `как считают Кристал и Метеора. Комиссии уже внутри полученного.</span></td>` +
      `<td class="num"><b class="${total >= 0 ? 'ok' : 'bad'}">${
        total >= 0 ? '+' : ''}${total.toFixed(2)}</b></td>`;
    tb.prepend(head);
    log(`история: ${rows.length} позиций, из них закрытых ${counted}`, 'ok');
  }

  // ── карточка сделки ─────────────────────────────────────────────────────
  //
  // Показывается после закрытия и по кнопке в истории. Не копится: одна
  // карточка на экране, закрывается щелчком. Скачивается картинкой.
  // КАРТОЧКА СДЕЛКИ.
  //
  // Приведена к тому виду, который автор видит в Telegram и который ему
  // больше нравится: пара и номер сверху, крупный итог в стейбле, процент
  // от вложенного, строки «внёс / вернул / диапазон / цена на выходе» и
  // полоса, показывающая, где цена оказалась относительно диапазона.
  // Рисуем на холсте, а не разметкой: карточку надо уметь скачать картинкой.
  function drawCard(rec, id) {
    const W = 900, PAD = 52;
    const win = (rec.pnl ?? 0) >= 0;
    const st = rec.symStable || '';
    const num = (v, d = 2) => (v == null || !isFinite(v)) ? '—' : v.toFixed(d);
    const px = (v) => (v == null || !isFinite(v)) ? '—'
      : (v >= 1 ? v.toFixed(4) : v.toPrecision(4));

    // Строки таблицы собираем заранее: от их числа зависит высота холста.
    const rows = [];
    if (rec.amountIn != null) {
      const inTxt = rec.amountInToken != null && rec.depIsStable === false
        ? `${num(Number(rec.amountInToken))} ${rec.symIn || ''} (≈${num(rec.amountIn)} ${st})`
        : `${num(rec.amountIn)} ${st}`;
      rows.push(['внёс', inTxt, null]);
    }
    rows.push(['вернул', `${num(rec.got)} ${st}`, null]);
    if (rec.takenOut > 0) rows.push(['вынуто раньше', `${num(rec.takenOut)} ${st}`, '#81d8ad']);
    const hasBand = rec.lo != null && rec.hi != null;
    if (hasBand) rows.push(['диапазон', `${px(rec.lo)} — ${px(rec.hi)}`, null]);
    let inBand = null;
    if (hasBand && rec.exitPx != null) {
      inBand = rec.exitPx > rec.lo && rec.exitPx < rec.hi;
      rows.push(['цена на выходе', px(rec.exitPx), inBand ? '#81d8ad' : '#e2b87b']);
    }

    // Высота считается по содержимому. Первый вариант был ниже на сорок
    // точек, и подписи полосы диапазона наезжали на подвал — видно сразу,
    // но только если нарисовать и посмотреть, что я и сделал.
    const H = 236 + rows.length * 46 + (hasBand ? 96 : 44) + 34;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.fillStyle = '#181b20'; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W * 0.8, 90, 10, W * 0.8, 90, 460);
    glow.addColorStop(0, win ? 'rgba(129,216,173,.13)' : 'rgba(237,147,147,.12)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);

    // ── шапка
    g.fillStyle = '#edf0f4';
    g.font = '600 40px Inter,ui-sans-serif,system-ui,sans-serif';
    g.fillText(rec.pair || 'позиция', PAD, 74);
    g.fillStyle = '#788291';
    g.font = '400 19px Inter,ui-sans-serif,system-ui,sans-serif';
    const mins = rec.tEntry && rec.closed ? (rec.closed - rec.tEntry) / 60000 : null;
    const held = mins == null ? '' : ' · ' + (mins < 1 ? Math.max(1, Math.round(mins * 60)) + ' с'
      : mins < 60 ? Math.round(mins) + ' мин' : (mins / 60).toFixed(1) + ' ч') + ' в пуле';
    g.fillText(`позиция #${id || ''}${held}`, PAD, 104);

    // плашка состояния справа
    {
      const t = 'ЗАКРЫТА';
      g.font = '600 15px Inter,ui-sans-serif,system-ui,sans-serif';
      const w = g.measureText(t).width + 28;
      g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1;
      g.beginPath();
      if (g.roundRect) g.roundRect(W - PAD - w, 50, w, 32, 16);
      else g.rect(W - PAD - w, 50, w, 32);
      g.stroke();
      g.fillStyle = '#969eab';
      g.fillText(t, W - PAD - w + 14, 71);
    }

    // ── крупный итог
    g.fillStyle = win ? '#81d8ad' : '#ed9393';
    g.font = '600 78px ui-monospace,"SF Mono",Menlo,Consolas,monospace';
    const big = (win ? '+' : '−') + Math.abs(rec.pnl ?? 0).toFixed(2);
    g.fillText(big, PAD, 196);
    const bw = g.measureText(big).width;
    g.fillStyle = '#969eab';
    g.font = '500 26px Inter,ui-sans-serif,system-ui,sans-serif';
    g.fillText(st, PAD + bw + 18, 196);
    const pct = rec.amountIn ? (rec.pnl / rec.amountIn) * 100 : null;
    g.fillStyle = win ? '#81d8ad' : '#ed9393';
    g.font = '400 20px Inter,ui-sans-serif,system-ui,sans-serif';
    if (pct != null) {
      g.fillText(`${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% от вложенного`,
                 PAD, 230);
    }

    // ── строки
    let y = 272;
    g.font = '400 20px Inter,ui-sans-serif,system-ui,sans-serif';
    for (const [k, v, color] of rows) {
      g.fillStyle = '#969eab';
      g.textAlign = 'left';
      g.fillText(k, PAD, y);
      g.fillStyle = color || '#edf0f4';
      g.font = '500 20px ui-monospace,"SF Mono",Menlo,Consolas,monospace';
      g.textAlign = 'right';
      g.fillText(v, W - PAD, y);
      g.textAlign = 'left';
      g.font = '400 20px Inter,ui-sans-serif,system-ui,sans-serif';
      g.strokeStyle = 'rgba(255,255,255,.07)';
      g.setLineDash([3, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(PAD, y + 14.5); g.lineTo(W - PAD, y + 14.5); g.stroke();
      g.setLineDash([]);
      y += 46;
    }

    // ── полоса диапазона
    if (hasBand) {
      const bx = PAD, bw2 = W - PAD * 2, by = y + 6;
      g.fillStyle = '#12151a';
      g.beginPath();
      if (g.roundRect) g.roundRect(bx, by, bw2, 10, 5); else g.rect(bx, by, bw2, 10);
      g.fill();
      let pos = null;
      if (rec.exitPx != null) {
        pos = Math.max(0, Math.min(1, (rec.exitPx - rec.lo) / (rec.hi - rec.lo)));
        const grad = g.createLinearGradient(bx, 0, bx + bw2 * pos, 0);
        grad.addColorStop(0, 'rgba(129,216,173,.25)');
        grad.addColorStop(1, 'rgba(129,216,173,.6)');
        g.fillStyle = grad;
        g.beginPath();
        if (g.roundRect) g.roundRect(bx, by, Math.max(6, bw2 * pos), 10, 5);
        else g.rect(bx, by, Math.max(6, bw2 * pos), 10);
        g.fill();
        g.fillStyle = '#e2b87b';
        g.beginPath(); g.arc(bx + bw2 * pos, by + 5, 8, 0, Math.PI * 2); g.fill();
      }
      g.font = '400 15px Inter,ui-sans-serif,system-ui,sans-serif';
      g.fillStyle = '#788291';
      g.fillText(px(rec.lo), bx, by + 34);
      g.textAlign = 'right';
      g.fillText(px(rec.hi), bx + bw2, by + 34);
      g.textAlign = 'center';
      g.fillStyle = inBand === null ? '#788291' : (inBand ? '#81d8ad' : '#e2b87b');
      g.fillText(inBand === null ? 'цена на выходе не прочиталась'
        : (inBand ? 'цена внутри диапазона' : 'цена вне диапазона'), bx + bw2 / 2, by + 34);
      g.textAlign = 'left';
      y = by + 54;
    }

    // ── подвал
    g.fillStyle = '#55677a';
    g.font = '400 16px Inter,ui-sans-serif,system-ui,sans-serif';
    g.fillText('Uniswap V4' + (rec.fee != null && rec.fee < 0x800000
      ? ' · ' + (rec.fee / 10000).toFixed(2) + '%' : ''), PAD, H - 24);
    g.textAlign = 'right';
    g.fillText(C.RH.label + ' · LP терминал', W - PAD, H - 24);
    g.textAlign = 'left';
    return cv;
  }

  function showCard(id, rec) {
    document.querySelectorAll('.cardbox').forEach(x => x.remove());
    const box = document.createElement('div');
    box.className = 'cardbox';
    box.style.cssText = 'position:fixed;inset:0;background:rgba(3,6,10,.82);' +
      'display:flex;align-items:center;justify-content:center;z-index:9999;' +
      'flex-direction:column;gap:14px';
    const cv = drawCard(rec, id);
    cv.style.cssText = 'max-width:min(92vw,900px);width:100%;height:auto;' +
      'border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6)';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px';
    const dl = document.createElement('button');
    dl.textContent = 'Скачать картинку';
    dl.className = 'go';
    dl.onclick = () => {
      const a = document.createElement('a');
      a.download = `LP_${(rec.pair || id).replace('/', '_')}_${id}.png`;
      a.href = cv.toDataURL('image/png');
      a.click();
    };
    const cl = document.createElement('button');
    cl.textContent = 'Закрыть';
    cl.onclick = () => box.remove();
    row.append(dl, cl);
    box.append(cv, row);
    box.onclick = (e) => { if (e.target === box) box.remove(); };
    document.body.appendChild(box);
  }

  // ── запуск ──────────────────────────────────────────────────────────────
  load();
  amtRow();
  chips($('r-width'), [15, 30, 50, 70], '%', () => state.width, v => state.width = v);
  chips($('r-gap'), [1, 3, 5, 10], '%', () => state.gap, v => state.gap = v);
  sideRow();

  $('b-rpc').onclick = checkRpc;
  // Масштаб графика. Перерисовываем текущее состояние, ничего не пересчитывая
  // и не трогая сеть: это чисто про то, как широко мы смотрим.
  {
    const redraw = () => {
      const p = recalc();
      if (!p) drawChart(null);
      log(`поле зрения: ${(ZOOMS[zoomIdx] * 100).toFixed(0)}% ширины диапазона по краям`);
    };
    const zo = $('z-out'), zi = $('z-in');
    if (zo) zo.onclick = () => { if (zoomIdx < ZOOMS.length - 1) { zoomIdx++; redraw(); } };
    if (zi) zi.onclick = () => { if (zoomIdx > 0) { zoomIdx--; redraw(); } };
  }

  $('b-pool').onclick = loadPool;
  // Очистить поле одним нажатием: на телефоне дописать адрес к старому
  // проще, чем стереть, и именно из-за этого терминал грузил тот же пул.
  { const b = $('b-poolclear'); if (b) b.onclick = () => { $('pool').value = ''; $('pool').focus(); }; }
  $('b-arm').onclick = arm;
  $('b-open').onclick = open;
  $('b-pos').onclick = loadPositions;
  // Кнопка была нарисована, но ни к чему не привязана — история
  // обновлялась только при подключении кошелька.
  $('b-hist').onclick = () => loadHistory();
  $('b-wallet').onclick = async () => {
    try {
      const w = await W.connect();
      state.account = w.address;
      $('d-wallet').className = 'dot on';
      $('s-wallet').textContent = w.address.slice(0, 6) + '…' + w.address.slice(-4);
      log('кошелёк подключён: ' + w.address, 'ok');
      startPositionsPump();
      loadWalletBalances().catch(() => {});
    loadWalletBalances().catch(() => {});
      // Сеть переключаем сразу, а не в момент подписи. Иначе автор сначала
      // соберёт вход, а потом упрётся в отказ на самом последнем шаге.
      if (w.chainId !== C.RH.chainId) {
        log(`кошелёк в сети ${w.chainId}, а нужна ${C.RH.chainId} (BNB Chain) — прошу переключить`, 'warn');
        try {
          await W.ensureChain(w.provider);
          log('сеть переключена на BNB Chain', 'ok');
        } catch (e) {
          log(e.message + '. В Rabby выбери BNB Chain и нажми «Подключить» ещё раз', 'bad');
        }
      }
      // Позиции — сразу: ради них и подключаемся, и там кнопка «Закрыть».
      // История сама не грузится: это десятки запросов к общему публичному
      // узлу, он от них отвечает «internal server error», и страдают ПОЗИЦИИ.
      // Нужна история — есть кнопка.
      loadPositions();
      loadBalance().catch(() => {});
    } catch (e) { log('кошелёк: ' + e.message, 'bad'); }
  };

  // ── горячая клавиша ─────────────────────────────────────────────────────
  //
  // Вход по Enter, когда курсор НЕ в поле ввода. Автор сказал: важна
  // каждая секунда, и тянуться мышью к кнопке — потеря времени.
  //
  // Предохранитель: двойное срабатывание подряд блокируется, пока идёт
  // отправка. Кошелёк всё равно спросит подтверждение — деньги не уйдут
  // от случайного нажатия, но открывать окно дважды незачем.
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (state.busy) { log('уже отправляю, подожди', 'warn'); return; }
      log('Enter — вход');
      open();
    }
    if (e.key === 'r' || e.key === 'к') { loadPositions(); }
  });

  // ── недавние пулы ───────────────────────────────────────────────────────
  function drawPools() {
    const host = $('recent');
    if (!host) return;
    host.innerHTML = '';
    for (const p of state.pools.slice(0, 6)) {
      const b = document.createElement('button');
      b.textContent = p.name;
      b.title = p.id;
      b.onclick = () => { $('pool').value = p.id; loadPool(); };
      host.appendChild(b);
    }
  }

  function rememberPool(id, name) {
    state.pools = [{ id, name }, ...state.pools.filter(p => p.id !== id)].slice(0, 6);
    save(); drawPools();
  }

  drawPools();

  // ── ПЕРЕКЛЮЧАТЕЛЬ СЕТИ ──────────────────────────────────────────────────
  //
  // Переключение перезагружает страницу, и это сделано намеренно. Сеть меняет
  // адреса контрактов, узел, ключи памяти, кэш цен, профиль ликвидности и
  // список позиций. Подменять всё это на живой странице — верный способ
  // оставить где-нибудь хвост от прошлой сети и посчитать по нему деньги.
  // Перезагрузка занимает мгновение и не оставляет хвостов вовсе.
  function drawChains() {
    const host = $('chains');
    if (!host) return;
    host.innerHTML = '';
    for (const [name, c] of Object.entries(C.CHAINS)) {
      const b = document.createElement('button');
      b.textContent = c.label;
      if (name === chainName) b.className = 'on';
      b.onclick = () => {
        if (name === chainName) return;
        if (state.busy) { log('идёт отправка — сеть не переключаю', 'warn'); return; }
        try { localStorage.setItem(CHAIN_KEY, name); } catch (e) { }
        location.reload();
      };
      host.appendChild(b);
    }
  }
  drawChains();

  // Если сайт уже разрешён в кошельке, подхватываем адрес молча — без окна
  // и без нажатий. Иначе после каждого обновления страницы панель позиций
  // пишет «подключи кошелёк», и выглядит это так, будто терминал потерял
  // открытую позицию.
  (async () => {
    const w = await W.reconnect();
    if (!w) return;
    state.account = w.address;
    $('d-wallet').className = 'dot on';
    $('s-wallet').textContent = w.address.slice(0, 6) + '…' + w.address.slice(-4);
    log('кошелёк уже разрешён здесь: ' + w.address, 'ok');
    startPositionsPump();
    if (w.chainId !== C.RH.chainId)
      log(`но кошелёк в сети ${w.chainId}, а нужна ${C.RH.chainId} (${C.RH.label}) — ` +
          'переключи в Rabby или нажми «Подключить»', 'warn');
    else loadPositions();
  })();

  const rpcEl = $('rpc'); if (rpcEl) rpcEl.placeholder = C.RH.rpcHint || '';
  const verEl = $('ver');
  if (verEl) verEl.textContent = `${C.RH.label} · v${VERSION}`;
  // Наружу отдаём только показ карточки: пригодится и для проверки, и
  // чтобы можно было открыть карточку по прошлой сделке из консоли.
  window.RHTerminal = { showCard, drawCard, version: VERSION };
  log(`терминал ${VERSION}, сеть ${C.RH.label} (${C.RH.chainId}). Enter — вход, R — обновить позиции.`);
  if (state.rpcUrl) checkRpc().then(ok => { if (ok && $('pool').value) loadPool(); });
})();

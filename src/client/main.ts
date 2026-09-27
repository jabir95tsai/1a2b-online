import './style.css';
import type { SoloView, SoloStepView } from '../protocol/solo.ts';
import type { RoomView, RoomStep } from '../protocol/room.ts';
const app = document.querySelector<HTMLDivElement>('#app')!;
type Mode = 'home' | 'A' | 'B' | 'C';
let mode: Mode = 'home', solo: SoloView | null = null, room: RoomView | null = null;
let socket: WebSocket | null = null, stopped = false, connected = false, busy = false, notice = '', invite = '';
let reconnectAttempts = 0, leaving = false;
let invitedCode = '';
// Local UI state. `viewKey` identifies the move being entered; when it changes
// (next step, next round, new game) the half-typed tray and pickers reset.
let draft = '', pick = { a: 0, b: 0 }, correcting: number | null = null, correctMode = false, viewKey = '';
let historyTab: 'me' | 'opp' = 'me';
const setup = { limit: '10', soloKind: 'B-honest', roomKind: 'duel' };
const reasons: Record<string, string> = { solved: '猜中答案', draw: '同回合雙方命中', timeout: '回合逾時', disconnect: '離線超過寬限時間', abandoned: '玩家主動離開', cancelled: '等待逾時，對局取消' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const pad = (n: number) => String(n).padStart(2, '0');
const cn = ['零', '一', '兩', '三', '四'];
async function api(path: string, body?: unknown) {
    const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok)
        throw new Error(data.error.message + (data.error.turns ? `（衝突步驟：${data.error.turns.join('、')}）` : ''));
    return data;
}

// ── Tray and keypad ─────────────────────────────────────
const tile = (d: string, cls = '') => `<span class="tile${cls ? ' ' + cls : ''}">${esc(d)}</span>`;
function tiles(digits: string, cls = '', attrs = '') { return `<span class="tiles" aria-hidden="true"${attrs}>${[...digits.padEnd(4, '?').slice(0, 4)].map(d => tile(d, cls)).join('')}</span>`; }
function entryTiles() { return [0, 1, 2, 3].map(i => i < draft.length ? tile(draft[i]!) : `<span class="tile slot${i === draft.length ? ' active' : ''}">·</span>`).join(''); }
function keypad() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map(d => { const used = draft.includes(String(d)); return `<button type="button" class="key${used ? ' used' : ''}" data-key="${d}"${used ? ' aria-disabled="true"' : ''} aria-label="${d}${used ? '，已填入' : ''}">${d}</button>`; }).join(''); }
const entryLabel = (label: string) => draft.length === 4 ? label : `再填${cn[4 - draft.length]}格`;
function entryForm(form: string, name: string, label: string, submit: string) {
    return `<form data-form="${form}" class="entry"><label class="tray entry-tray"><span class="sr-only">${label}（四位不重複數字）</span><input class="tray-input" name="${name}" value="${esc(draft)}" inputmode="none" autocomplete="off" spellcheck="false" maxlength="4"><span class="tiles" aria-hidden="true">${entryTiles()}</span></label><div class="keypad" role="group" aria-label="數字鍵盤">${keypad()}</div><div class="entry-actions"><button type="button" class="ghost-action" data-key="del">刪除</button><button type="submit" class="primary-action" data-label="${submit}">${entryLabel(submit)}</button></div></form>`;
}
function syncEntry() {
    const form = app.querySelector<HTMLFormElement>('form.entry');
    if (!form)
        return;
    const input = form.querySelector<HTMLInputElement>('.tray-input')!;
    if (input.value !== draft)
        input.value = draft;
    form.querySelector('.tiles')!.innerHTML = entryTiles();
    form.querySelectorAll<HTMLButtonElement>('.key').forEach(k => { const used = draft.includes(k.dataset.key!); k.classList.toggle('used', used); k.toggleAttribute('aria-disabled', used); k.setAttribute('aria-label', `${k.dataset.key}${used ? '，已填入' : ''}`); });
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.textContent = entryLabel(submit.dataset.label!);
    submit.disabled = locked() || draft.length < 4;
}
// Four distinct ASCII digits; full-width digits from an IME are folded to ASCII.
function sanitize(value: string) { let out = ''; for (const ch of value.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))) if (/[0-9]/.test(ch) && !out.includes(ch) && out.length < 4) out += ch; return out; }

// ── Shared pieces ───────────────────────────────────────
function top(title: string, right = '') { return `<header class="top"><button class="back" data-mode="home"><span aria-hidden="true">←</span><span class="sr-only">返回首頁：</span>${title}</button>${right}</header><div id="notice" role="status" class="error-banner">${esc(notice)}</div>`; }
const chip = (text: string) => `<span class="chip">${text}</span>`;
function rows(list: (SoloStepView | RoomStep)[], selectable = false) {
    if (!list.length)
        return '<p class="empty-note">第一條線索，從你的下一手開始。</p>';
    return `<ol class="score-list">${list.map((r, i) => { const s = r as SoloStepView; const body = `<span><span class="row-label"><i>${pad(i + 1)}</i><strong>${esc(r.guess)}</strong></span>${s.candidatesAfter !== undefined ? `<small>${s.candidatesBefore} → ${s.candidatesAfter} 組</small>` : ''}</span><b>${r.feedback.a}A${r.feedback.b}B</b>`; return `<li>${selectable ? `<button type="button" class="score-row" data-action="pick-turn" data-turn="${i + 1}" aria-label="修正第 ${i + 1} 手 ${esc(r.guess)}，目前 ${r.feedback.a}A${r.feedback.b}B">${body}</button>` : `<div class="score-row scored">${body}</div>`}</li>`; }).join('')}</ol>`;
}
function historyCard(title: string, list: SoloStepView[], extra = '') { return `<section class="card history-card"><div class="card-head"><h2>${title}</h2>${extra}</div>${rows(list, correctMode)}${correctMode ? '<p class="hint">點一列來修正，之後的步驟會重新推理。</p>' : ''}</section>`; }
function render() {
    const focused = document.activeElement as HTMLElement | null;
    const focusSel = focused && focused !== document.body ? selectorFor(focused) : null;
    const values = Array.from(app.querySelectorAll<HTMLInputElement>('input:not([type="radio"]):not(.tray-input)')).map(e => [e.name, e.value]);
    resetOnChange();
    app.innerHTML = content();
    for (const [name, value] of values) {
        const e = app.querySelector<HTMLInputElement>(`input[name="${name}"]:not([type="radio"]):not(.tray-input)`);
        if (e)
            e.value = value!;
    }
    if (focusSel)
        app.querySelector<HTMLElement>(focusSel)?.focus();
    // A WebSocket update may arrive before the matching HTTP response. Keep the
    // newly rendered form locked until that request has finished clearing inputs.
    app.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button[type="submit"],input').forEach(e => e.disabled = locked() || (e instanceof HTMLInputElement && e.type === 'radio' && e.dataset.impossible === 'true'));
    syncEntry();
    updateClock();
}
const locked = () => busy || (mode === 'C' && !!room && !connected);
function selectorFor(el: HTMLElement) {
    const input = el as HTMLInputElement;
    if (input.name)
        return `[name="${input.name}"]${input.type === 'radio' ? `[value="${input.value}"]` : ''}`;
    for (const key of ['action', 'key', 'mode', 'tab'] as const)
        if (el.dataset[key])
            return `[data-${key}="${el.dataset[key]}"]${el.dataset.turn ? `[data-turn="${el.dataset.turn}"]` : ''}`;
    return null;
}
function resetOnChange() {
    const g = room?.game;
    const key = mode === 'C' ? `room:${room?.gameId}:${g?.phase}:${g?.round}:${g?.canGuess}:${g?.canSetAnswer}` : `solo:${mode}:${solo?.id}:${solo?.steps}:${solo?.status}`;
    if (key === viewKey)
        return;
    viewKey = key;
    draft = '';
    pick = { a: 0, b: 0 };
    correcting = null;
    correctMode = false;
}
function content(): string {
    if (mode === 'home')
        return homeContent();
    if (mode === 'C')
        return room ? roomContent() : roomSetup();
    if (solo && ((mode === 'A') === (solo.kind === 'A')))
        return soloContent();
    return mode === 'A' ? soloASetup() : soloBSetup();
}

// ── Home ────────────────────────────────────────────────
function homeContent() {
    const resume = (m: 'A' | 'B') => solo && solo.status === 'active' && (solo.kind === 'A') === (m === 'A') ? `進行中・已走 ${solo.steps} 步，點一下繼續。` : '';
    const modes = [
        { m: 'A', title: '我來猜', desc: resume('A') || '電腦藏好答案，換你逐步破解。' },
        { m: 'B', title: '電腦猜', desc: resume('B') || '看 5040 種可能，收斂成唯一答案。' },
        { m: 'C', title: '好友對戰', desc: room ? `房間 ${esc(room.code)} 進行中，點一下回到牌桌。` : '互猜對方答案，或同步挑戰同一道題。' },
    ];
    return `<div class="screen home"><header class="brand-bar"><a href="#" data-mode="home" class="brand"><b>1A<span>2B</span></b><small>數字之間</small></a></header><div id="notice" role="status" class="error-banner">${esc(notice)}</div><div class="home-grid"><section class="hero"><h1>四個數字。<br>一點直覺，<em>更多推理。</em></h1><div class="tray hero-tray" aria-hidden="true"><span class="tiles">${tile('0')}${tile('1', 'hit')}${tile('2')}${tile('3', 'near')}</span></div><p class="sr-only">例如答案是 4 1 3 5，猜 0 1 2 3 會得到 1A1B。</p></section><nav class="modes" aria-label="選擇玩法">${modes.map(x => `<button class="mode-card" data-mode="${x.m}" aria-label="${x.title}" aria-describedby="mode-${x.m}"><span class="mode-copy"><span class="mode-title">${x.title}</span><span class="mode-desc" id="mode-${x.m}">${x.desc}</span></span><span class="mode-arrow" aria-hidden="true">→</span></button>`).join('')}</nav></div><footer class="rules">4 位不重複數字 · 允許 0 開頭<br>A 代表位置也正確，B 代表數字正確、位置不同。</footer></div>`;
}

// ── Setup screens ───────────────────────────────────────
function seg(name: string, current: string, items: [string, string][], legend: string) { return `<fieldset class="field"><legend>${legend}</legend><div class="seg">${items.map(([value, label]) => `<label class="seg-item${value === current ? ' active' : ''}"><input type="radio" name="${name}" value="${value}"${value === current ? ' checked' : ''}><span>${label}</span></label>`).join('')}</div></fieldset>`; }
function soloASetup() {
    return `<div class="screen">${top('我來猜')}<section class="card setup-card"><div class="setup-copy"><h1>你來找出<em>唯一答案。</em></h1><p>電腦藏好四位不重複數字，每一手都會拿到 A/B 回饋。</p></div><form data-form="solo-create" class="form-body">${seg('limit', setup.limit, [['10', '10 次'], ['custom', '自訂'], ['unlimited', '無限']], '猜測次數')}${setup.limit === 'custom' ? '<label class="field"><span>自訂次數</span><input name="count" type="number" inputmode="numeric" min="1" max="1000" value="10" required></label>' : ''}<button type="submit" class="primary-action">開始新局</button></form></section></div>`;
}
function soloBSetup() {
    const honest = setup.soloKind === 'B-honest';
    return `<div class="screen">${top('電腦猜')}<section class="card setup-card"><div class="setup-copy"><h1>換電腦<em>讀懂你的線索。</em></h1><p>${honest ? '先把答案交給伺服器，電腦每一手都自動拿到回饋。' : '答案留在你心裡，每一手由你告訴電腦幾 A 幾 B。說錯了之後還能改。'}</p></div><form data-form="solo-create" class="form-body">${seg('kind', setup.soloKind, [['B-honest', '誠實模式'], ['B-oral', '口述模式']], '回饋方式')}${honest ? '<label class="field"><span>你的答案</span><input name="answer" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="四位不重複數字" required></label>' : ''}<button type="submit" class="primary-action">開始新局</button><p class="privacy-note">所有計算都由伺服端完成。</p></form></section></div>`;
}
function roomSetup() {
    const duel = setup.roomKind === 'duel';
    return `<div class="screen">${top('好友對戰')}<section class="card setup-card"><div class="setup-copy"><h1>好對手，<em>好線索。</em></h1><p>${duel ? '輪流出手，猜對方藏起來的答案。後手保留同回合機會，雙中和局。' : '同一道題，每回合一起鎖定、一起揭曉。每回合 60 秒。'}</p></div><form data-form="room-create" class="form-body">${seg('kind', setup.roomKind, [['duel', '互猜答案'], ['race', '同步競速']], '對戰玩法')}<button type="submit" class="primary-action">建立房間</button><p class="privacy-note">進行中只公開對手步數，結束後公開完整歷程。</p></form></section><form data-form="room-join" class="join-bar"><label class="field"><span>有朋友給你房碼？</span><input class="code-input" name="code" value="${esc(invitedCode)}" minlength="8" maxlength="8" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="8 碼房碼"></label><button type="submit" class="secondary-action">加入房間</button></form></div>`;
}

// ── Solo ────────────────────────────────────────────────
function soloContent() {
    const g = solo!, active = g.status === 'active';
    if (g.kind === 'A') {
        const play = active
            ? entryForm('solo-guess', 'guess', '你的猜測', '送出猜測')
            : `<section class="card result-card"><div class="tray">${tiles(g.answer ?? '????', g.outcome === 'won' ? 'hit' : '')}<span class="tray-note">答案揭曉</span></div><h2>${({ won: '你猜中了！', lost: '本次機會已用完', abandoned: '已結束這一局' } as Record<string, string>)[g.outcome!] ?? '本局結束'}</h2><button type="button" class="primary-action" data-action="new-solo">再來一局</button></section>`;
        return `<div class="screen wide">${top('我來猜', chip(`${g.steps} 步${g.maxGuesses ? ` / ${g.maxGuesses}` : ''}`))}<div class="layout"><div class="play">${play}${active ? '<button type="button" class="text-action" data-action="abandon-solo">結束並揭曉</button>' : ''}</div><div class="side">${historyCard('推理紀錄', g.history)}</div></div></div>`;
    }
    const oral = g.kind === 'B-oral';
    const correctToggle = oral && active && g.steps ? `<button type="button" class="link-action" data-action="toggle-correct" aria-pressed="${correctMode}">${correctMode ? '取消修正' : '修正回饋'}</button>` : '';
    let play: string;
    if (!active)
        play = `<section class="card result-card"><div class="tray">${tiles(g.answer ?? '????', 'hit')}<span class="tray-note">${g.outcome === 'solved' ? `電腦用 ${g.steps} 步找到答案` : '答案揭曉'}</span></div><h2>${({ solved: '電腦已找到答案', abandoned: '已結束這一局' } as Record<string, string>)[g.outcome!] ?? '本局結束'}</h2><button type="button" class="primary-action" data-action="new-solo">再來一局</button></section>`;
    else if (correcting !== null) {
        const step = g.history[correcting - 1]!;
        play = `<div class="tray">${tiles(step.guess, '', ' data-testid="pending"')}<span class="tray-note">第 ${correcting} 手，原本回覆 ${step.feedback.a}A${step.feedback.b}B</span></div>${feedbackCard('correct', `正確的回饋是？`, '重新計算', `<input type="hidden" name="turn" value="${correcting}">`, '<button type="button" class="text-action" data-action="cancel-correct">取消</button>')}`;
    }
    else
        play = `<div class="tray">${tiles(g.pendingGuess ?? '????', '', ' data-testid="pending"')}<span class="tray-note">目前剩餘 <b>${g.candidateCount}</b> 組可能</span></div>${oral ? feedbackCard('feedback', '這一手對了多少？', `送出 ${pick.a}A${pick.b}B`) : '<form data-form="solo-next"><button type="submit" class="primary-action">取得回饋與下一手</button></form>'}`;
    return `<div class="screen wide">${top('電腦猜', chip(active ? `第 ${g.steps + 1} 手` : `${g.steps} 步`))}<div class="layout"><div class="play">${play}${active && correcting === null ? '<button type="button" class="text-action" data-action="abandon-solo">結束並揭曉</button>' : ''}</div><div class="side">${historyCard(oral ? '推理紀錄' : '電腦的推理', g.history, correctToggle)}</div></div></div>`;
}
function feedbackCard(form: string, title: string, submit: string, hidden = '', after = '') {
    const row = (name: 'a' | 'b', label: string) => `<div class="pick-row" role="radiogroup" aria-label="${label}"><span class="pick-label" aria-hidden="true">${name.toUpperCase()}</span><div class="pick-options">${[0, 1, 2, 3, 4].map(n => { const impossible = name === 'b' && (n > 4 - pick.a || (pick.a === 3 && n === 1)); const on = pick[name] === n; return `<label class="pick${on ? ' on' : ''}${impossible ? ' no' : ''}"><input type="radio" name="${name}" value="${n}"${on ? ' checked' : ''} data-impossible="${impossible}" aria-label="${n}${name.toUpperCase()}"><span aria-hidden="true">${n}</span></label>`; }).join('')}</div></div>`;
    return `<form data-form="${form}" class="card feedback-card">${hidden}<h2>${title}</h2>${row('a', 'A：數字和位置都對')}${row('b', 'B：數字對、位置不同')}<button type="submit" class="primary-action">${submit}</button>${after}</form>`;
}

// ── Rooms ───────────────────────────────────────────────
function roomContent() {
    const r = room!, g = r.game, opponent = r.players[r.you === 0 ? 1 : 0];
    const title = r.kind === 'duel' ? '互猜答案' : '同步競速';
    const status = `<div class="room-status"><span class="badge"><span class="${connected ? 'live-dot' : 'live-dot off'}"></span>${connected ? '已連線' : '連線中'} · 第 ${r.matchNumber} 局</span><b id="clock"></b></div>`;
    const leave = `<button type="button" class="text-action" data-action="leave-room">${g?.phase === 'finished' ? '離開房間' : '離開並結束對戰'}</button>`;
    if (!g)
        return `<div class="screen">${top(title)}${status}<section class="card waiting-card"><h1>留一個位置，<br>給你的對手。</h1><p>分享邀請連結或房碼。等待室 10 分鐘後到期。</p><div class="code-display"><strong>${esc(r.code)}</strong><button type="button" data-action="share">複製邀請</button></div><div class="lobby-seats"><div class="seat"><span class="avatar">你</span><span>你</span></div><div class="seat empty"><span class="avatar" aria-hidden="true">＋</span><span>還有位子</span></div></div><p class="waiting-note"><span class="live-dot"></span>等待好友加入…</p></section>${leave}</div>`;
    const pill = `<div class="room-pill"><strong>${esc(r.code)}</strong><button type="button" data-action="share">邀請</button></div>`;
    const result = g.result;
    let card: string;
    if (g.phase === 'finished') {
        const ending = result ? (result.reason === 'cancelled' ? '雙方逾時，本局取消' : result.winner === null ? '旗鼓相當，和局！' : result.winner === r.you ? '你贏了！' : '本局由對手獲勝') : '本局結束';
        const answer = (seat: number, label: string) => `<div class="answer"><span>${label}</span><div class="tray mini">${tiles(g.answers?.[seat] ?? '????', 'idle')}</div></div>`;
        card = `<section class="card result-card"><div class="card-head"><h2>${ending}</h2><span class="accent">${esc(reasons[result?.reason ?? ''] ?? '')}</span></div>${!g.answers ? '' : r.kind === 'race' ? `<div class="answers single">${answer(r.you, '本題答案')}</div>` : `<div class="answers">${answer(r.you, '你的答案')}${answer(r.you === 0 ? 1 : 0, '對手的答案')}</div>`}<form data-form="rematch"><button type="submit" class="primary-action">${r.players[r.you]?.rematch ? '取消再戰邀請' : '再來一局'}</button></form><p class="privacy-note">${opponent?.rematch ? '對手已同意再戰' : '等待雙方同意後開始新局'}</p></section>`;
    }
    else {
        const myTurn = r.kind === 'duel' ? g.turn === r.you : g.canGuess;
        const theirTurn = r.kind === 'duel' && g.phase === 'playing' && g.turn !== r.you;
        const head = g.phase === 'setup' ? '先藏好你的答案' : `第 ${g.round} 回合`;
        const state = g.canSetAnswer ? '對手看不到' : g.canGuess ? (r.kind === 'duel' ? '輪到你出手' : '一起鎖定這一手') : g.phase === 'setup' ? '等待對手' : g.myPending ? '已鎖定' : '對手出手中';
        const waiting = g.phase === 'setup' ? '答案已藏好，等待對手。' : g.myPending ? `已鎖定 ${esc(g.myPending)}，等待對手。` : r.kind === 'duel' ? '對手正在想下一手…' : '等待對手完成操作。';
        const body = g.canSetAnswer ? entryForm('answer', 'answer', '你的秘密答案', '確認答案')
            : g.canGuess ? entryForm('room-guess', 'guess', '你的猜測', '鎖定這一手')
                : `<div class="tray idle">${tiles(g.myPending ?? '????', 'idle')}</div><p class="waiting-note"><span class="live-dot"></span>${waiting}</p>`;
        card = `<section class="card play-card"><div class="card-head"><h2>${head}</h2><span class="accent">${state}</span></div>${body}<div class="players-strip"><article class="player-chip${myTurn ? ' active' : ''}"><span class="avatar">你</span><span class="player-copy">你<small>${g.myHistory.length} 步</small></span></article><article class="player-chip${theirTurn ? ' active' : ''}"><span class="avatar">對</span><span class="player-copy">對手<small>${g.opponentSteps} 步 · ${opponent?.connected ? '在線' : '暫時離線'}</small></span></article></div></section>`;
    }
    const opp = g.opponentHistory ? rows(g.opponentHistory) : '<div class="privacy"><h3>線索，各自保留。</h3><p>這一局結束後，就能一起回顧雙方的完整推理。</p></div>';
    const history = `<section class="card history-card"><div class="auth-tabs" role="tablist">${([['me', '我的紀錄'], ['opp', `對手 ${g.opponentSteps} 步`]] as const).map(([id, label]) => `<button type="button" role="tab" aria-selected="${historyTab === id}" class="${historyTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div><div role="tabpanel">${historyTab === 'me' ? rows(g.myHistory) : opp}</div></section>`;
    return `<div class="screen wide">${top(title, pill)}${status}<div class="layout"><div class="play">${card}</div><div class="side">${history}</div></div>${leave}</div>`;
}
function updateClock() { const el = document.querySelector('#clock'); if (el && room) {
    const deadline = room.game?.deadline ?? room.expiresAt;
    el.textContent = deadline ? `${Math.max(0, Math.ceil((deadline - Date.now()) / 1000))} 秒` : '';
} }
function applyRoom(next: RoomView) { if (!room || room.incarnation !== next.incarnation || next.revision >= room.revision)
    room = next; render(); }
function connect() {
    if (!room || stopped)
        return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/rooms/${room.code}/ws`);
    socket = ws;
    ws.onmessage = e => { if (socket !== ws || e.data === 'pong')
        return; const message = JSON.parse(e.data); if (message.type === 'room') {
        connected = true;
        reconnectAttempts = 0;
        applyRoom(message.room);
    }
    else if (message.type === 'replaced') {
        stopped = true;
        connected = false;
        notice = '已在其他視窗開啟。此分頁已停止操作。';
        render();
    }
    else if (message.type === 'expired') {
        stopped = true;
        connected = false;
        // Leaving a waiting room expires it; that expected close is not an error for the leaver.
        if (!leaving)
            notice = '房間已回收。';
        room = null;
        localStorage.removeItem('room');
        render();
    } };
    ws.onclose = () => { if (socket !== ws)
        return; connected = false; render(); if (!stopped)
        setTimeout(() => { if (socket === ws && !stopped)
            connect(); }, Math.min(30000, 1500 * 2 ** reconnectAttempts++)); };
}
async function soloAction(action: Record<string, unknown>) { const g = solo!; solo = (await api(`/solo/${g.id}/actions`, { requestId: crypto.randomUUID(), generation: g.generation, expectedRevision: g.revision, ...action })).game; }
async function sendRoomAction(action: Record<string, unknown>): Promise<RoomView> { const r = room!; return (await api(`/rooms/${r.code}/actions`, { requestId: crypto.randomUUID(), incarnation: r.incarnation, gameId: r.gameId, connectionEpoch: r.connectionEpoch, ...action })).room; }
async function roomAction(action: Record<string, unknown>) { applyRoom(await sendRoomAction(action)); }
async function run(work: () => Promise<void>) { if (busy)
    return; busy = true; notice = ''; render(); try {
    await work();
}
catch (e) {
    notice = e instanceof Error ? e.message : '連線失敗，請重試。';
}
finally {
    busy = false;
    render();
} }
app.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const data = new FormData(form);
    const get = (k: string) => String(data.get(k) ?? '');
    void run(async () => {
        switch (form.dataset.form) {
            case 'solo-create':
                solo = (await api('/solo', { requestId: crypto.randomUUID(), ...(mode === 'A' ? { kind: 'A', maxGuesses: get('limit') === 'unlimited' ? null : get('limit') === 'custom' ? Number(get('count')) : 10 } : { kind: get('kind'), ...(get('kind') === 'B-honest' ? { answer: get('answer') } : {}) }) })).game;
                localStorage.setItem('solo', solo!.id);
                break;
            case 'solo-guess':
                await soloAction({ type: 'guess', guess: get('guess') });
                break;
            case 'solo-next':
                await soloAction({ type: 'next' });
                break;
            case 'feedback':
                await soloAction({ type: 'feedback', feedback: { a: Number(get('a')), b: Number(get('b')) } });
                break;
            case 'correct':
                await soloAction({ type: 'correct', turn: Number(get('turn')), feedback: { a: Number(get('a')), b: Number(get('b')) } });
                correcting = null;
                break;
            case 'room-create': {
                const result = await api('/rooms', { requestId: crypto.randomUUID(), kind: get('kind') });
                room = result.room;
                localStorage.setItem('room', room!.code);
                stopped = false;
                historyTab = 'me';
                connect();
                break;
            }
            case 'room-join':
                room = (await api(`/rooms/${get('code').toUpperCase()}/join`, invite && get('code').toUpperCase() === invitedCode ? { inviteToken: invite } : {})).room;
                localStorage.setItem('room', room!.code);
                stopped = false;
                historyTab = 'me';
                connect();
                break;
            case 'answer':
                await roomAction({ type: 'set-answer', round: room!.game!.round, answer: get('answer') });
                break;
            case 'room-guess':
                await roomAction({ type: 'guess', round: room!.game!.round, guess: get('guess') });
                break;
            case 'rematch':
                await roomAction({ type: 'rematch', accept: !room!.players[room!.you]!.rematch });
                break;
        }
        if (form.classList.contains('entry'))
            draft = '';
        app.querySelectorAll<HTMLInputElement>('input[name="answer"]:not(.tray-input)').forEach(i => i.value = '');
    });
});
app.addEventListener('input', e => {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains('tray-input'))
        return;
    draft = sanitize(input.value);
    syncEntry();
});
app.addEventListener('change', e => {
    const input = e.target as HTMLInputElement;
    if (input.type !== 'radio')
        return;
    const form = input.form?.dataset.form;
    if (input.name === 'a' || input.name === 'b') {
        pick[input.name] = Number(input.value);
        if (pick.b > 4 - pick.a || (pick.a === 3 && pick.b === 1))
            pick.b = 0;
    }
    else if (input.name === 'limit')
        setup.limit = input.value;
    else if (input.name === 'kind')
        setup[form === 'room-create' ? 'roomKind' : 'soloKind'] = input.value;
    render();
});
app.addEventListener('click', e => { const button = (e.target as Element).closest<HTMLElement>('[data-mode],[data-action],[data-key],[data-tab]'); if (!button)
    return; e.preventDefault(); if (button.dataset.mode) {
    mode = button.dataset.mode as Mode;
    notice = '';
    render();
    window.scrollTo(0, 0);
    return;
} if (button.dataset.key) {
    if (locked())
        return;
    draft = button.dataset.key === 'del' ? draft.slice(0, -1) : sanitize(draft + button.dataset.key);
    syncEntry();
    return;
} if (button.dataset.tab) {
    historyTab = button.dataset.tab as 'me' | 'opp';
    render();
    return;
} switch (button.dataset.action) {
    case 'toggle-correct':
        correctMode = !correctMode;
        render();
        return;
    case 'pick-turn': {
        const step = solo!.history[Number(button.dataset.turn) - 1]!;
        correcting = Number(button.dataset.turn);
        pick = { ...step.feedback };
        correctMode = false;
        render();
        app.querySelector<HTMLInputElement>('[name="a"]:checked')?.focus();
        return;
    }
    case 'cancel-correct':
        correcting = null;
        pick = { a: 0, b: 0 };
        render();
        return;
} void run(async () => { switch (button.dataset.action) {
    case 'new-solo':
        solo = null;
        localStorage.removeItem('solo');
        break;
    case 'abandon-solo':
        if (confirm('結束這一局並揭曉答案？'))
            await soloAction({ type: 'abandon' });
        break;
    case 'share': {
        const shareToken = (await api('/rooms/' + room!.code + '/invite')).inviteToken;
        await navigator.clipboard.writeText(`${location.origin}/#join=${room!.code}.${shareToken}`);
        notice = '邀請連結已複製';
        break;
    }
    case 'leave-room':
        if (room?.game?.phase !== 'finished' && !confirm('離開將結束這一局，確定離開？'))
            return;
        if (room?.life === 'active' || room?.life === 'waiting') {
            leaving = true;
            try {
                await sendRoomAction({ type: 'leave' });
            }
            finally {
                leaving = false;
            }
        }
        stopped = true;
        socket?.close();
        socket = null;
        room = null;
        connected = false;
        localStorage.removeItem('room');
        break;
} }); });
setInterval(() => { updateClock(); if (socket?.readyState === WebSocket.OPEN)
    socket.send('ping'); }, 25000);
setInterval(updateClock, 1000);
render();
void run(async () => { await api('/session', {}); if (readInvite())
    return; const savedRoom = localStorage.getItem('room'); if (savedRoom) {
    try {
        room = (await api(`/rooms/${savedRoom}`)).room;
        mode = 'C';
        connect();
    }
    catch {
        localStorage.removeItem('room');
    }
} const savedSolo = localStorage.getItem('solo'); if (savedSolo) {
    try {
        solo = (await api(`/solo/${savedSolo}`)).game;
        if (!room)
            mode = solo!.kind === 'A' ? 'A' : 'B';
    }
    catch {
        localStorage.removeItem('solo');
    }
} });
function historyReplace() { window.history.replaceState(null, '', location.pathname); }
function readInvite(): boolean {
    const fragment = /^#join=([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8})(?:\.([a-f0-9]{64}))?$/.exec(location.hash);
    if (!fragment)
        return false;
    historyReplace();
    mode = 'C';
    invite = fragment[2] ?? '';
    invitedCode = fragment[1]!;
    if (room && room.code !== invitedCode)
        notice = '請先離開目前房間，再加入邀請的房間。';
    render();
    const input = app.querySelector<HTMLInputElement>('[name="code"]');
    if (input)
        input.value = invitedCode;
    return true;
}
window.addEventListener('hashchange', readInvite);

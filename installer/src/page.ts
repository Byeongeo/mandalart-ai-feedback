// 설치 안내 화면(한 페이지). HTML·CSS·JS를 문자열로 갖고 있다가 index.ts가 돌려줍니다.
// CSP가 인라인 스크립트·스타일을 막으므로 JS·CSS는 /installer.js, /installer.css로 따로 내보냅니다.
// 주의: PAGE_JS는 String.raw 안에 있으므로 JS 안에서 백틱(`)과 '${'를 쓰지 마세요.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderPage(o: { version: string; builtAt: string; tokenUrl: string }): string {
  return PAGE_HTML.replaceAll("{{VERSION}}", esc(o.version)).replaceAll("{{TOKEN_URL}}", esc(o.tokenUrl));
}

const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';

const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>AI 만다라트 피드백 · 내 앱 설치</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/installer.css">
<script src="/installer.js" defer></script>
</head>
<body class="mode-install" data-version="{{VERSION}}">
<header class="top">
  <div class="wrap">
    <p class="brand">AI 만다라트 피드백</p>
    <h1><span data-mode="install">내 Cloudflare에 앱 설치하기</span><span data-mode="update">내 앱 업데이트하기</span></h1>
    <p class="lead" data-mode="install">선생님 전용 앱을 내 Cloudflare 계정에 무료로 만들어요. GitHub나 프로그램 설치는 필요 없어요. 10~15분쯤 걸려요.</p>
    <p class="lead" data-mode="update">이미 설치한 앱을 새 버전(<b>{{VERSION}}</b>)으로 바꿔요. 학생 글과 교사 계정은 그대로 남아요. 5분쯤 걸려요.</p>
    <nav class="tabs" aria-label="할 일 고르기">
      <a href="#install" id="tab-install">처음 설치</a>
      <a href="#update" id="tab-update">업데이트</a>
    </nav>
  </div>
</header>

<main class="wrap">
  <noscript><p class="error">이 페이지는 JavaScript가 켜져 있어야 해요. 브라우저 설정에서 JavaScript를 켠 뒤 다시 열어 주세요.</p></noscript>

  <section class="card" id="step1" aria-labelledby="h1">
    <div class="num" aria-hidden="true">1</div>
    <h2 id="h1"><span data-mode="install">Cloudflare 가입 또는 로그인</span><span data-mode="update">Cloudflare 로그인</span></h2>
    <div data-mode="install">
      <p>Cloudflare 계정이 없으면 가입하고, 있으면 로그인만 하세요. <b>도메인이나 카드(결제 수단)는 필요 없어요.</b></p>
      <div class="buttons">
        <a class="btn primary" href="https://dash.cloudflare.com/sign-up" ${NEW_TAB}>Cloudflare 가입하기 ↗</a>
        <a class="btn" href="https://dash.cloudflare.com/login" ${NEW_TAB}>계정이 있어요 · 로그인 ↗</a>
      </div>
      <ol class="how">
        <li>가입 화면에서 이메일과 비밀번호를 넣고 가입해요.</li>
        <li><b>메일함에서 Cloudflare 인증 메일을 열고 'Verify email'을 꼭 눌러요.</b> 안 보이면 스팸함도 보세요. 인증을 안 하면 설치가 안 돼요.</li>
        <li>도메인 추가(Add a domain)나 요금제 화면이 나와도 아무것도 고르지 말고 이 탭으로 돌아오세요.</li>
      </ol>
    </div>
    <div data-mode="update">
      <p>앱을 설치했던 Cloudflare 계정으로 로그인하세요.</p>
      <div class="buttons"><a class="btn primary" href="https://dash.cloudflare.com/login" ${NEW_TAB}>Cloudflare 로그인 ↗</a></div>
    </div>
  </section>

  <section class="card" id="step2" aria-labelledby="h2">
    <div class="num" aria-hidden="true">2</div>
    <h2 id="h2">설치 토큰 만들기</h2>
    <p>토큰은 이 페이지가 내 계정에 앱을 만들 수 있게 <b>잠깐 빌려주는 열쇠</b>예요. 끝나면 지워요.</p>
    <div class="buttons"><a class="btn primary big" id="token-link" href="{{TOKEN_URL}}" ${NEW_TAB}>설치 토큰 만들기 ↗</a></div>
    <p class="small">새 탭에 토큰 만들기 화면이 열려요(로그인 화면이 나오면 로그인한 뒤 이 버튼을 한 번 더 누르세요). 아래 순서대로 하세요.</p>
    <ol class="how">
      <li><b>Permissions</b>에 세 줄이 채워져 있는지 봐요: <i>Account Settings · Read</i>, <i>Workers Scripts · Edit</i>, <i>D1 · Edit</i>.</li>
      <li><b>Account Resources</b>: <i>Include</i> 옆 칸에서 <b>내 계정</b>(보통 '내 이메일's Account')을 골라요.</li>
      <li>(고르지 않아도 돼요) <b>TTL</b>: 끝나는 날을 오늘(연수가 끝나는 날)로 정하면 더 안전해요.</li>
      <li>맨 아래 <b>Continue to summary</b> → 다음 화면의 <b>Create Token</b>을 눌러요.</li>
      <li>나온 토큰 옆 <b>Copy</b>를 눌러 복사하고 이 탭으로 돌아와요. 토큰은 이때 한 번만 보여요.</li>
    </ol>
    <p class="note">Cloudflare 로그인 비밀번호, 'Global API Key', OpenRouter(AI) 키는 넣지 마세요. 이 페이지는 토큰을 저장하지 않아요.</p>
  </section>

  <section class="card" id="step3" aria-labelledby="h3">
    <div class="num" aria-hidden="true">3</div>
    <h2 id="h3"><span data-mode="install">토큰 붙여 넣고 설치하기</span><span data-mode="update">토큰 붙여 넣고 업데이트하기</span></h2>
    <label for="token">Cloudflare 설치 토큰</label>
    <div class="row">
      <input id="token" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="2000" placeholder="여기에 붙여 넣기">
      <button type="button" class="btn small" id="show-token" aria-pressed="false">보기</button>
    </div>
    <div class="buttons"><button type="button" class="btn primary" id="check">계정 확인</button></div>
    <p id="check-msg" class="msg" role="status" aria-live="polite"></p>

    <div id="accounts" hidden>
      <p class="label"><span data-mode="install">앱을 설치할 계정</span><span data-mode="update">앱을 설치했던 계정</span></p>
      <div id="account-list" class="choices" role="radiogroup" aria-label="Cloudflare 계정"></div>
      <label class="check" data-mode="update">
        <input type="checkbox" id="new-code">
        <span>설정 코드도 새로 만들기<br><span class="small">첫 교사 계정을 아직 못 만들었거나, 비밀번호를 잊었는데 설정 코드도 잃어버렸을 때만 고르세요.</span></span>
      </label>
      <div class="buttons">
        <button type="button" class="btn primary big" id="start" disabled><span data-mode="install">설치 시작</span><span data-mode="update">업데이트 시작</span></button>
      </div>
      <p class="small" data-mode="update">수업 중에는 하지 마세요. 업데이트하는 1~2분 동안 학생 화면이 잠깐 저장을 못 할 수 있어요.</p>
    </div>

    <div id="progress" hidden>
      <progress id="bar" max="100" value="0" aria-label="진행 정도"></progress>
      <ol id="steps" class="steps"></ol>
      <p id="now" class="msg" role="status" aria-live="polite"></p>
      <p class="small" id="wait-hint">이 탭을 닫지 말고 기다려 주세요.</p>
    </div>
    <div id="error" class="error" role="alert" hidden>
      <p id="error-text"></p>
      <div class="buttons" id="error-goto" hidden><a class="btn primary" id="error-goto-link"></a></div>
    </div>
  </section>

  <section class="card done" id="step4" aria-labelledby="done-title" hidden>
    <div class="num" aria-hidden="true">4</div>
    <h2 id="done-title" tabindex="-1"><span data-mode="install">설치가 끝났어요</span><span data-mode="update">업데이트가 끝났어요</span></h2>
    <p id="ready-msg" class="msg"></p>
    <label for="app-url">내 앱 주소 <span class="small">(학생에게도 이 주소를 알려 줘요)</span></label>
    <div class="row">
      <input id="app-url" readonly>
      <button type="button" class="btn small" id="copy-url">복사</button>
    </div>
    <p id="copy-msg" class="small" role="status"></p>

    <div id="setup-box" hidden>
      <div class="buttons"><a class="btn primary big" id="setup-link" ${NEW_TAB}><span data-mode="install">첫 교사 계정 만들기 ↗</span><span data-mode="update">설정 화면 열기 ↗</span></a></div>
      <p data-mode="install"><b>이 페이지를 닫기 전에</b> 위 버튼을 눌러 교사 아이디와 비밀번호를 정하세요. 화면이 안 열리면 1~2분 뒤 다시 누르세요.</p>
      <p data-mode="update"><b>이 페이지를 닫기 전에</b> 위 버튼을 눌러 교사 계정을 만들거나(아직 없을 때) 비밀번호를 다시 정하세요. 예전 설정 코드는 이제 쓸 수 없어요.</p>
      <label for="setup-code">설정 코드 <span class="small">(비밀번호를 잊었을 때 다시 정하는 데도 써요. 메모장 등에 적어 두세요)</span></label>
      <div class="row">
        <input id="setup-code" readonly>
        <button type="button" class="btn small" id="copy-code">복사</button>
      </div>
    </div>
    <div class="buttons" id="open-box"><a class="btn" id="open-app" ${NEW_TAB}>내 앱 열기 ↗</a></div>

    <div class="todo">
      <h3>꼭 할 일: 설치 토큰 지우기</h3>
      <p>토큰은 이제 필요 없어요. 아래 버튼을 누르고 목록에서 <i>AI Mandalart install (temporary)</i> 줄 오른쪽의 <b>···</b> → <b>Delete</b>를 누르세요.</p>
      <div class="buttons"><a class="btn" href="https://dash.cloudflare.com/profile/api-tokens" ${NEW_TAB}>토큰 지우러 가기 ↗</a></div>
    </div>
    <div class="todo" data-mode="install">
      <h3>다음: AI 연결 키 넣기</h3>
      <p>다음: 선생님 화면의 'AI 연결 키'에 강사에게 받은 키를 넣으세요.</p>
    </div>
  </section>
</main>
<footer class="wrap small">설치·업데이트할 앱 버전 {{VERSION}} · 이 페이지는 토큰을 저장하지 않아요.</footer>
</body>
</html>
`;

export const PAGE_CSS = `:root{--bg:#f6f4ef;--card:#fff;--ink:#22201c;--muted:#5f5a52;--line:#ddd7cc;--accent:#0f6b5c;--accent-ink:#fff;--accent-soft:#e3f1ed;--warn:#8a4b00;--warn-soft:#fff3dc;--err:#a3271b;--err-soft:#fdecea}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR","Segoe UI",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
.wrap{max-width:720px;margin:0 auto;padding:0 16px}
.top{background:var(--accent);color:var(--accent-ink);padding:24px 0 0}
.brand{margin:0;font-size:14px;opacity:.85;font-weight:600;letter-spacing:.02em}
h1{margin:4px 0 8px;font-size:26px;line-height:1.3}
.lead{margin:0 0 16px;opacity:.95}
.tabs{display:flex;gap:4px}
.tabs a{flex:1;text-align:center;padding:12px 8px;border-radius:12px 12px 0 0;color:var(--accent-ink);text-decoration:none;font-weight:700;background:rgba(255,255,255,.14)}
.tabs a[aria-current="page"]{background:var(--bg);color:var(--accent)}
main{padding-top:20px;padding-bottom:24px}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 18px 20px 64px;margin:0 0 18px}
.num{position:absolute;left:16px;top:18px;width:34px;height:34px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-weight:800}
h2{margin:0 0 10px;font-size:21px;line-height:1.35}
h3{margin:0 0 6px;font-size:17px}
p{margin:0 0 10px}
.how{margin:10px 0;padding-left:22px}
.how li{margin:6px 0}
.buttons{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:10px 18px;border-radius:12px;border:2px solid var(--accent);background:#fff;color:var(--accent);font:inherit;font-weight:700;text-decoration:none;cursor:pointer;text-align:center}
.btn:hover{background:var(--accent-soft)}
.btn.primary{background:var(--accent);color:var(--accent-ink)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.big{min-height:58px;font-size:19px;padding:12px 26px}
.btn.small{min-height:44px;padding:6px 14px;font-size:15px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn:focus-visible,input:focus-visible,.tabs a:focus-visible{outline:3px solid #f0a500;outline-offset:2px}
label{display:block;font-weight:700;margin:12px 0 6px}
.label{font-weight:700;margin:14px 0 6px}
.row{display:flex;gap:8px;align-items:stretch}
input[type=password],input[type=text],input:not([type]){flex:1;min-width:0;min-height:48px;padding:10px 12px;border:2px solid var(--line);border-radius:10px;font:16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#fff;color:var(--ink)}
input[readonly]{background:#f3f1ec}
.choices{display:flex;flex-direction:column;gap:8px}
.choice{display:flex;gap:10px;align-items:center;margin:0;padding:12px 14px;border:2px solid var(--line);border-radius:12px;cursor:pointer;font-weight:600}
.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.choice input,.check input{width:22px;height:22px;flex:none;accent-color:var(--accent)}
.choice small{display:block;color:var(--muted);font-weight:400;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:600;margin:14px 0 0}
.small{font-size:14px;color:var(--muted);font-weight:400}
.note{background:var(--warn-soft);color:var(--warn);border-radius:10px;padding:10px 12px;font-size:15px}
.msg{min-height:1.6em;margin:8px 0 0}
.msg.bad{color:var(--err);font-weight:600}
.msg.good{color:var(--accent);font-weight:600}
.error{background:var(--err-soft);color:var(--err);border:1px solid #f1b7b0;border-radius:12px;padding:12px 14px;margin-top:12px;font-weight:600;white-space:pre-line}
progress{width:100%;height:14px;accent-color:var(--accent)}
.steps{list-style:none;margin:10px 0 0;padding:0}
.steps li{position:relative;padding:4px 0 4px 30px;color:var(--muted)}
.steps li::before{content:"";position:absolute;left:4px;top:10px;width:14px;height:14px;border-radius:50%;border:2px solid var(--line)}
.steps li.active{color:var(--ink);font-weight:700}
.steps li.active::before{border-color:var(--accent);border-top-color:transparent;animation:spin 1s linear infinite}
.steps li.ok{color:var(--ink)}
.steps li.ok::before{content:"✓";border:0;top:3px;left:3px;color:var(--accent);font-weight:900;width:auto;height:auto}
.steps li.fail{color:var(--err);font-weight:700}
.steps li.fail::before{content:"!";border:0;top:3px;left:8px;color:var(--err);font-weight:900;width:auto;height:auto}
@keyframes spin{to{transform:rotate(360deg)}}
.done{border:2px solid var(--accent)}
.todo{border-top:1px solid var(--line);margin-top:16px;padding-top:14px}
footer{padding-bottom:32px}
.mode-install [data-mode="update"],.mode-update [data-mode="install"]{display:none!important}
[hidden]{display:none!important}
@media (max-width:480px){h1{font-size:22px}.card{padding:18px 14px 18px 14px}.num{position:static;margin:0 0 8px}.btn.big{width:100%}.buttons .btn{flex:1 1 auto}}
@media (prefers-reduced-motion:reduce){.steps li.active::before{animation:none}}
`;

export const PAGE_JS = String.raw`(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var mode = 'install';
  var busy = false;
  var finished = false;
  var guard = false;
  var accountsToken = '';

  var STEPS = {
    install: [['check', '설치된 앱 확인'], ['subdomain', '앱 주소 준비'], ['database', '데이터베이스 준비'], ['upload', '앱 올리기'], ['route', '앱 주소 켜기'], ['wait', '앱이 대답하는지 확인']],
    update: [['check', '설치된 앱 확인'], ['database', '데이터베이스 찾기'], ['upload', '새 버전 올리기'], ['secret', '새 설정 코드 넣기'], ['route', '앱 주소 확인'], ['wait', '앱이 대답하는지 확인']]
  };

  // ── 화면 모드(#install / #update) ──
  function setMode() {
    if (busy) return;
    mode = location.hash === '#update' ? 'update' : 'install';
    body.className = 'mode-' + mode;
    $('tab-install').setAttribute('aria-current', mode === 'install' ? 'page' : 'false');
    $('tab-update').setAttribute('aria-current', mode === 'update' ? 'page' : 'false');
    document.title = (mode === 'update' ? '내 앱 업데이트' : '내 앱 설치') + ' · AI 만다라트 피드백';
    if (finished) resetAll();
    $('error').hidden = true;
    $('progress').hidden = true;
  }
  window.addEventListener('hashchange', setMode);
  setMode();

  // ── 토큰 ──
  // Cloudflare가 보여 주는 확인용 명령(curl … Bearer <토큰>)을 통째로 붙여 넣어도 토큰만 꺼냅니다.
  function cleanToken(raw) {
    var s = String(raw || '').trim();
    var m = /Bearer\s+([A-Za-z0-9._~+\/=-]+)/.exec(s);
    if (m) s = m[1];
    return s.replace(/^["'\x60]+|["'\x60]+$/g, '').trim();
  }
  function tokenProblem(raw) {
    if (/sk-or-/i.test(raw)) return '붙여 넣은 것은 OpenRouter(AI) 키예요. 이 칸에는 Cloudflare 설치 토큰을 넣어야 해요. AI 키는 설치가 끝난 뒤 내 앱의 교사 화면 \'AI 연결 키\'에 넣으세요.';
    var t = cleanToken(raw);
    if (!t) return '먼저 2단계에서 만든 토큰을 붙여 넣어 주세요.';
    if (!/^[A-Za-z0-9._~+\/=-]{20,300}$/.test(t)) return '토큰 모양이 아니에요. Cloudflare 토큰 화면의 \'Copy\' 버튼으로 복사한 값을 그대로 붙여 넣어 주세요.';
    return '';
  }

  var token = $('token');
  $('show-token').addEventListener('click', function () {
    var show = token.type === 'password';
    token.type = show ? 'text' : 'password';
    this.textContent = show ? '가리기' : '보기';
    this.setAttribute('aria-pressed', String(show));
  });
  token.addEventListener('input', function () {
    if (busy) return;
    if (cleanToken(token.value) !== accountsToken) clearAccounts();
  });
  token.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); if (!$('check').disabled) checkAccounts(); }
  });

  function setMsg(el, text, kind) {
    el.textContent = text || '';
    el.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function clearAccounts() {
    accountsToken = '';
    $('accounts').hidden = true;
    $('account-list').replaceChildren();
    $('start').disabled = true;
    setMsg($('check-msg'), '');
  }

  async function postJson(path, payload) {
    var res;
    try {
      res = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        credentials: 'same-origin', cache: 'no-store', redirect: 'error'
      });
    } catch (e) {
      throw new Error('설치 페이지 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
    }
    if (!res.ok) {
      var detail = await res.json().catch(function () { return null; });
      throw new Error((detail && detail.error) || '설치 페이지 서버에서 문제가 생겼어요(' + res.status + '). 잠시 뒤 다시 눌러 주세요.');
    }
    return res;
  }

  // ── 계정 확인 ──
  async function checkAccounts() {
    if (busy) return;
    var problem = tokenProblem(token.value);
    var msg = $('check-msg');
    $('error').hidden = true;
    if (problem) { clearAccounts(); setMsg(msg, problem, 'bad'); token.focus(); return; }
    var t = cleanToken(token.value);
    if (finished) resetAll();
    clearAccounts();
    $('check').disabled = true;
    setMsg(msg, 'Cloudflare에서 토큰과 계정을 확인하고 있어요…');
    try {
      var accounts = await (await postJson('/api/accounts', { token: t })).json();
      if (cleanToken(token.value) !== t) return;
      if (!Array.isArray(accounts) || !accounts.length) throw new Error('설치할 수 있는 계정이 없어요.');
      var list = $('account-list');
      accounts.forEach(function (a) {
        var label = document.createElement('label');
        label.className = 'choice';
        var input = document.createElement('input');
        input.type = 'radio';
        input.name = 'account';
        input.value = a.id;
        input.addEventListener('change', function () { $('start').disabled = false; });
        var text = document.createElement('span');
        text.textContent = a.name;
        var small = document.createElement('small');
        small.textContent = 'ID ' + a.id.slice(0, 8) + '…';
        text.appendChild(small);
        label.appendChild(input);
        label.appendChild(text);
        list.appendChild(label);
      });
      if (accounts.length === 1) { list.querySelector('input').checked = true; $('start').disabled = false; }
      accountsToken = t;
      $('accounts').hidden = false;
      setMsg(msg, accounts.length === 1 ? '토큰이 맞아요. 아래 버튼을 누르세요.' : '토큰이 맞아요. 계정이 여러 개예요. 하나를 고르세요.', 'good');
    } catch (e) {
      if (cleanToken(token.value) === t) setMsg(msg, e.message, 'bad');
    } finally {
      $('check').disabled = false;
    }
  }
  $('check').addEventListener('click', checkAccounts);

  // ── 진행 상황 ──
  function drawSteps() {
    var ol = $('steps');
    ol.replaceChildren();
    STEPS[mode].forEach(function (s) {
      if (s[0] === 'secret' && !$('new-code').checked) return;
      var li = document.createElement('li');
      li.dataset.step = s[0];
      li.textContent = s[1];
      ol.appendChild(li);
    });
  }
  function markStep(key, state) {
    var items = Array.prototype.slice.call($('steps').children);
    var idx = items.findIndex(function (li) { return li.dataset.step === key; });
    if (idx < 0) return;
    items.forEach(function (li, i) {
      if (i < idx) li.className = 'ok';
      else if (i === idx) li.className = state;
      else if (state !== 'fail') li.className = '';
    });
    $('bar').value = Math.round(((idx + (state === 'ok' ? 1 : 0.5)) / items.length) * 100);
  }
  function currentStep() {
    var a = $('steps').querySelector('li.active');
    return a ? a.dataset.step : '';
  }

  function selectedAccount() {
    var r = document.querySelector('input[name=account]:checked');
    return r ? r.value : '';
  }

  async function start() {
    if (busy) return;
    var accountId = selectedAccount();
    var t = cleanToken(token.value);
    if (!accountId || t !== accountsToken) { setMsg($('check-msg'), '먼저 \'계정 확인\'을 눌러 주세요.', 'bad'); return; }
    if (finished) resetAll();
    busy = true; guard = true;
    $('start').disabled = true; $('check').disabled = true; token.disabled = true;
    $('error').hidden = true;
    $('progress').hidden = false;
    $('wait-hint').hidden = false;
    drawSteps();
    $('bar').value = 2;
    setMsg($('now'), '시작하고 있어요…');
    var payload = { token: t, accountId: accountId, mode: mode };
    if (mode === 'update') payload.newSetupCode = $('new-code').checked;
    try {
      var res = await postJson('/api/install', payload);
      await follow(res);
    } catch (e) {
      var step = currentStep();
      if (step) markStep(step, 'fail');
      $('wait-hint').hidden = true;
      $('error-text').textContent = e.message + (e.retry === false ? '' : '\n\n고친 뒤 \'' + (mode === 'update' ? '업데이트 시작' : '설치 시작') + '\'을 다시 누르면 이어서 해요.');
      var go = e.goto === 'update' || e.goto === 'install' ? e.goto : '';
      $('error-goto').hidden = !go;
      if (go) {
        $('error-goto-link').href = '#' + go;
        $('error-goto-link').textContent = go === 'update' ? '업데이트 화면으로 가기' : '처음 설치 화면으로 가기';
      }
      $('error').hidden = false;
      setMsg($('now'), '');
      $('start').disabled = false; $('check').disabled = false; token.disabled = false;
      guard = false;
    } finally {
      busy = false;
    }
  }
  $('start').addEventListener('click', start);

  async function follow(res) {
    if (!res.body) throw new Error('설치 페이지 서버의 응답을 읽지 못했어요. 다시 눌러 주세요.');
    var reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    var buf = '';
    for (;;) {
      var chunk = await reader.read().catch(function () { return { done: true, value: '' }; });
      if (chunk.value) buf += chunk.value;
      var lines = buf.split('\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        var ev;
        try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
        if (ev.type === 'step') { markStep(ev.step, 'active'); setMsg($('now'), ev.message); }
        else if (ev.type === 'error') {
          var err = new Error(ev.message);
          err.retry = ev.retry;
          err.goto = ev.goto;
          throw err;
        }
        else if (ev.type === 'done') { showDone(ev); return; }
      }
      if (chunk.done) break;
    }
    throw new Error('설치 페이지 서버와 연결이 끊겼어요. 설치가 거의 끝났을 수도 있어요.');
  }

  // ── 끝 ──
  function showDone(ev) {
    var url;
    try { url = new URL(ev.url); } catch (e) { throw new Error('앱 주소를 받지 못했어요. 다시 눌러 주세요.'); }
    if (url.protocol !== 'https:' || !/\.workers\.dev$/.test(url.hostname)) throw new Error('앱 주소가 이상해요. 강사에게 알려 주세요.');
    var appUrl = url.origin;
    Array.prototype.forEach.call($('steps').children, function (li) { li.className = 'ok'; });
    $('bar').value = 100;
    $('wait-hint').hidden = true;
    setMsg($('now'), mode === 'update' ? '업데이트를 마쳤어요.' : '설치를 마쳤어요.', 'good');
    $('app-url').value = appUrl;
    $('open-app').href = appUrl + '/teacher';
    setMsg($('ready-msg'), ev.ready
      ? '앱이 대답하는 것을 확인했어요.'
      : '새 주소가 인터넷에 퍼지는 데 몇 분(길면 10분쯤) 걸릴 수 있어요. 버튼을 눌렀는데 \'찾을 수 없음\' 화면이 나오면 잠시 뒤 다시 눌러 보세요.',
      ev.ready ? 'good' : '');
    var setup = typeof ev.setupUrl === 'string' && ev.setupUrl.indexOf(appUrl + '/teacher/setup#code=') === 0 ? ev.setupUrl : '';
    if (setup) {
      $('setup-link').href = setup;
      $('setup-code').value = setup.slice(setup.indexOf('#code=') + 6);
      $('setup-box').hidden = false;
      $('open-box').hidden = true;
    } else {
      $('setup-box').hidden = true;
      $('open-box').hidden = false;
      guard = false;
    }
    // 토큰은 더 쓰지 않으므로 화면에서 지웁니다.
    token.value = '';
    $('new-code').checked = false;
    token.disabled = false;
    $('check').disabled = false;
    clearAccounts();
    finished = true;
    $('step4').hidden = false;
    $('done-title').focus();
    $('step4').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function resetAll() {
    finished = false; guard = false;
    $('step4').hidden = true;
    $('setup-box').hidden = true;
    $('app-url').value = '';
    $('setup-code').value = '';
    $('setup-link').removeAttribute('href');
    setMsg($('copy-msg'), '');
  }

  async function copy(input, done) {
    try { await navigator.clipboard.writeText(input.value); setMsg($('copy-msg'), done); }
    catch (e) { input.focus(); input.select(); setMsg($('copy-msg'), '선택된 글자를 Ctrl+C(휴대폰은 길게 눌러 복사)로 복사하세요.'); }
  }
  $('copy-url').addEventListener('click', function () { copy($('app-url'), '앱 주소를 복사했어요.'); });
  $('copy-code').addEventListener('click', function () { copy($('setup-code'), '설정 코드를 복사했어요. 안전한 곳에 적어 두세요.'); guard = false; });
  $('setup-link').addEventListener('click', function () { guard = false; });

  window.addEventListener('beforeunload', function (e) {
    if (guard) { e.preventDefault(); e.returnValue = ''; }
  });
})();
`;
